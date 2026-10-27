import { createHmac } from "node:crypto";
import pg from "pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService, AuthStore, ConsoleMailer } from "../auth/service.js";
import { startAuthServer, type RunningServer } from "../auth/server.js";
import type { ForwardDeps } from "../inbox/forward.js";
import { HOOK_PATH } from "../inbox/hook.js";
import { InboxStore } from "../inbox/store.js";
import { InboxWorker } from "../inbox/worker.js";
import { ResendMailer } from "../auth/mailer.js";
import { SigninMeter } from "./resend-usage.js";
import { FakeResend } from "../../scripts/smoke/fake-resend.js";

// Loop 052, checker round 1: a received email is never lost (pending, retried,
// sent once under an Idempotency-Key), and everything counts against the shared
// Resend quota (B1): received mail, forwards, names-only resends, the alert.

const KEY = Buffer.from("aW5ib3gtcmV0cnktdGVzdC1rZXktMDEyMzQ1Ng==", "base64");
const ID = "55555555-0000-4000-8000-000000000001";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let server: RunningServer;
let deps: ForwardDeps;
let worker: InboxWorker;
const fake = new FakeResend();

const received = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  object: "email", id, from: "Rosa <rosa@bloom.test>", to: ["hi@skovern.com"], cc: [], reply_to: [],
  subject: "Order", text: "Two dozen roses.", html: null,
  authentication: { spf: "pass", dkim: "pass", dmarc: "pass" }, attachments: [], ...over,
});

beforeAll(async () => {
  const { url } = await fake.listen();
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", (err: Error & { code?: string }) => {
    if (err.code !== "57P01") throw err;
  });
  await new AuthStore(pool).migrate();
  const store = new InboxStore(pool);
  await store.migrate();
  deps = { api: { baseUrl: url, apiKey: "re_test" }, store, from: "Skovern inbox <inbox@in.skovern.com>", forwardTo: "dawid@inbox.test", maxPerDay: 25, quota: { quota: 100, reserve: 15 } };
  worker = new InboxWorker(deps);
  const auth = new AuthService(new AuthStore(pool), new ConsoleMailer(), { appUrl: "http://x" });
  server = await startAuthServer({ service: auth, inbox: { key: KEY, store, worker, pool }, accountRoutes: false });
});

afterAll(async () => {
  await worker?.drain();
  await server?.close();
  await pool?.end();
  await container?.stop();
  fake.close();
});

beforeEach(async () => {
  fake.reset();
  deps.maxPerDay = 25;
  deps.quota = { quota: 100, reserve: 15 };
  await pool.query("TRUNCATE resend_hook_ids, inbox_mail, resend_usage");
});

let seq = 0;
async function deliver(emailId: string): Promise<number> {
  const body = JSON.stringify({ type: "email.received", data: { email_id: emailId } });
  const id = `msg_retry${(seq += 1)}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", KEY).update(`${id}.${ts}.${body}`).digest("base64");
  const r = await fetch(`${server.url}${HOOK_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` },
    body,
  });
  await settle();
  return r.status;
}
async function settle(): Promise<void> {
  worker.kick();
  await worker.drain();
}
/** Make every pending email due now, as if its wait had passed. */
const due = (): Promise<unknown> => pool.query(`UPDATE inbox_mail SET next_try = now() WHERE outcome = 'pending'`);
const outcome = async (id: string): Promise<string | undefined> =>
  (await pool.query<{ outcome: string }>(`SELECT outcome FROM inbox_mail WHERE email_id = $1`, [id])).rows[0]?.outcome;
const usage = async (): Promise<Record<string, number>> => {
  const r = await pool.query<{ kind: string; n: string }>(`SELECT kind, count(*) AS n FROM resend_usage GROUP BY kind`);
  return Object.fromEntries(r.rows.map((x) => [x.kind, Number(x.n)]));
};
const errors = (spy: { mock: { calls: unknown[][] } }): string => spy.mock.calls.map((c) => String(c[0])).join("\n");

describe("never losing a forward", () => {
  it("answers 200 at once, keeps a failed fetch pending, logs it by name, and forwards once on retry", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.inbound.set(ID, received(ID));
    fake.getFaults = [503];
    expect(await deliver(ID)).toBe(200);
    expect(await outcome(ID)).toBe("pending");
    expect(errors(err)).toContain(`fetching received email ${ID} failed (status 503 application_error)`);
    await settle();
    expect(fake.sent).toHaveLength(0);
    await due();
    await settle();
    expect(await outcome(ID)).toBe("forwarded");
    expect(fake.sent).toHaveLength(1);
    err.mockRestore();
  });

  it("retries a send whose answer was lost under the same key, delivering once", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.inbound.set(ID, received(ID));
    fake.sendFaults = ["lose"];
    await deliver(ID);
    expect(await outcome(ID)).toBe("pending");
    expect(errors(err)).toContain(`sending the forward of email ${ID} failed (status 500 internal_server_error)`);
    await due();
    await settle();
    expect(await outcome(ID)).toBe("forwarded");
    expect(fake.sent).toHaveLength(1);
    expect((await usage())["forward"]).toBe(1);
    err.mockRestore();
  });

  it("counts a 409 for a reused key (re-signed attachment links) as already sent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fake.inbound.set(ID, received(ID, { attachments: [{ id: "a1", filename: "a.pdf", content_type: null, content_id: null, size: 10 }] }));
    fake.rotateLinks = true;
    fake.sendFaults = ["lose"];
    await deliver(ID);
    await due();
    await settle();
    expect(await outcome(ID)).toBe("forwarded");
    expect(fake.sent).toHaveLength(1);
    expect(errors(warn)).toContain(
      `Resend reports forward/${ID} as already used, so the forward of email ${ID} is assumed delivered. If it didn't arrive, read it in Resend's Receiving tab.`,
    );
    vi.restoreAllMocks();
  });

  it("holds an email still pending after 24 hours", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fake.inbound.set(ID, received(ID));
    fake.sendFaults = [503];
    await deliver(ID);
    await pool.query(`UPDATE inbox_mail SET at = now() - interval '25 hours'`);
    await settle();
    expect(await outcome(ID)).toBe("held");
    expect(fake.sent).toHaveLength(0);
    vi.restoreAllMocks();
  });
});

describe("the shared Resend quota", () => {
  it("counts sign-in links, lets them use the reserve, and stops them at the whole quota", async () => {
    deps.quota = { quota: 10, reserve: 2 };
    const mailer = new ResendMailer("re_test", "Skovern <hi@skovern.com>", deps.api.baseUrl, new SigninMeter(pool, deps.quota));
    await pool.query(`INSERT INTO resend_usage (ref, kind) SELECT 'filler/' || g, 'welcome' FROM generate_series(1, 8) g`);
    await mailer.send("a@bloom.test", "https://api.test/auth?token=x"); // 8 = quota - reserve: still sent (9)
    await mailer.send("b@bloom.test", "https://api.test/auth?token=y"); // 10
    await expect(mailer.send("c@bloom.test", "https://api.test/auth?token=z")).rejects.toMatchObject({ status: 429 });
    expect(fake.sent).toHaveLength(2);
    expect((await usage())["signin"]).toBe(2);
    fake.sendFaults = [422];
    await pool.query(`DELETE FROM resend_usage WHERE ref = 'filler/1'`);
    await expect(mailer.send("d@bloom.test", "https://api.test/auth?token=w")).rejects.toMatchObject({ status: 422 });
    expect((await usage())["signin"]).toBe(2); // a refused send hands its count back
  });

  it("counts a forward as 2: the received email and the send", async () => {
    fake.inbound.set(ID, received(ID));
    await deliver(ID);
    expect(await usage()).toEqual({ received: 1, forward: 1 });
  });

  it("counts every received email, held and skipped ones too", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    deps.maxPerDay = 1;
    const ids = [1, 2, 3].map((n) => `66666666-0000-4000-8000-00000000000${n}`);
    for (const id of ids) fake.inbound.set(id, received(id));
    fake.inbound.set(ids[2]!, received(ids[2]!, { from: "hi@skovern.com" }));
    for (const id of ids) await deliver(id);
    expect([await outcome(ids[0]!), await outcome(ids[1]!), await outcome(ids[2]!)]).toEqual(["forwarded", "held", "skipped"]);
    expect(await usage()).toEqual({ received: 3, forward: 1, summary: 1 });
    vi.restoreAllMocks();
  });

  it("holds forwards at quota minus reserve, and lets the one alert use the reserve", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    deps.quota = { quota: 10, reserve: 2 };
    await pool.query(`INSERT INTO resend_usage (ref, kind) SELECT 'filler/' || g, 'welcome' FROM generate_series(1, 6) g`);
    const [a, b] = ["77777777-0000-4000-8000-000000000001", "77777777-0000-4000-8000-000000000002"];
    fake.inbound.set(a, received(a));
    fake.inbound.set(b, received(b));
    await deliver(a); // 7 used before the send → room under 8: forwarded (8)
    await deliver(b); // 9 used → no room: held; the alert goes out of the reserve (10)
    expect([await outcome(a), await outcome(b)]).toEqual(["forwarded", "held"]);
    expect(fake.sent.map((s) => s.subject)).toEqual(["[skovern.com] Order", "[skovern.com] Forwarding paused for today"]);
    const total = Object.values(await usage()).reduce((x, y) => x + y, 0);
    expect(total).toBe(10);
    vi.restoreAllMocks();
  });
});

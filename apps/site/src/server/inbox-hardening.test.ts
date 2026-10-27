import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import pg from "pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService, AuthStore, ConsoleMailer } from "../auth/service.js";
import { startAuthServer, type RunningServer } from "../auth/server.js";
import { resetAlertSkipLog, type ForwardDeps } from "../inbox/forward.js";
import { handleInboxHook, HOOK_PATH } from "../inbox/hook.js";
import { inboxFrom } from "../inbox/message.js";
import { RefusalLog } from "../inbox/refusals.js";
import { InboxStore } from "../inbox/store.js";
import { InboxWorker } from "../inbox/worker.js";
import { FakeResend } from "../../scripts/smoke/fake-resend.js";

// Loop 055 S2–S4: the sending subdomain, suspected spam and auto-replies held
// without spending a forward slot, the skipped-alert log line, raw-byte
// signatures, the 413 log, and refusal logs aggregated once a minute.

const KEY = Buffer.from("aW5ib3gtaGFyZGVuaW5nLXRlc3Qta2V5LTAxMjM=", "base64");
const FROM = inboxFrom("in.skovern.com");
const id = (n: number): string => `88888888-0000-4000-8000-00000000000${n}`;

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let server: RunningServer;
let deps: ForwardDeps;
let worker: InboxWorker;
const refusals = new RefusalLog(60_000);
const fake = new FakeResend();

const received = (emailId: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  object: "email", id: emailId, from: "Rosa <rosa@bloom.test>", to: ["hi@skovern.com"], cc: [], reply_to: [],
  subject: "Order", text: "Two dozen roses.", html: null, headers: {},
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
  deps = { api: { baseUrl: url, apiKey: "re_test" }, store, from: FROM, forwardTo: "dawid@inbox.test", maxPerDay: 25, flaggedPerDay: 2, quota: { quota: 100, reserve: 15 } };
  worker = new InboxWorker(deps);
  const auth = new AuthService(new AuthStore(pool), new ConsoleMailer(), { appUrl: "http://x" });
  server = await startAuthServer({ service: auth, inbox: { key: KEY, store, worker, pool, refusals }, accountRoutes: false });
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
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  refusals.flush();
  resetAlertSkipLog();
  vi.restoreAllMocks();
  deps.maxPerDay = 25;
  deps.quota = { quota: 100, reserve: 15 };
  await pool.query("TRUNCATE resend_hook_ids, inbox_mail, resend_usage");
});

let seq = 0;
function sign(body: Buffer, o: { key?: Buffer } = {}): Record<string, string> {
  const svixId = `msg_hard${(seq += 1)}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", o.key ?? KEY).update(`${svixId}.${ts}.`).update(body).digest("base64");
  return { "svix-id": svixId, "svix-timestamp": ts, "svix-signature": `v1,${sig}` };
}
async function post(body: Buffer, headers: Record<string, string>): Promise<Response> {
  const r = await fetch(`${server.url}${HOOK_PATH}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: new Uint8Array(body) });
  worker.kick();
  await worker.drain();
  return r;
}
const event = (emailId: string): Buffer => Buffer.from(JSON.stringify({ type: "email.received", data: { email_id: emailId } }));
const deliver = (emailId: string): Promise<Response> => post(event(emailId), sign(event(emailId)));
const outcome = async (emailId: string): Promise<string | undefined> =>
  (await pool.query<{ outcome: string }>(`SELECT outcome FROM inbox_mail WHERE email_id = $1`, [emailId])).rows[0]?.outcome;
const lines = (spy: { mock: { calls: unknown[][] } }, has: string): string[] =>
  spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(has));

describe("S2: the sending subdomain", () => {
  it("sends forwards and the daily alert from inbox@in.skovern.com, marked Auto-Submitted", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    deps.maxPerDay = 1;
    for (const n of [1, 2]) fake.inbound.set(id(n), received(id(n)));
    await deliver(id(1));
    await deliver(id(2));
    expect(fake.sent.map((m) => [m.from, m.headers?.["Auto-Submitted"]])).toEqual([
      [FROM, "auto-generated"],
      [FROM, "auto-generated"],
    ]);
    expect(fake.sent[1]?.subject).toBe("[skovern.com] Forwarding paused for today");
  });
});

describe("S3: flagged mail and auto-replies don't spend a main forward slot", () => {
  it("forwards a flagged email with [spam?] and the banner, without taking a main slot", async () => {
    deps.maxPerDay = 1;
    fake.inbound.set(id(1), received(id(1), { authentication: { spf: "gray", dkim: "gray", dmarc: "gray" }, reply_to: ["pay@elsewhere.test"] }));
    fake.inbound.set(id(2), received(id(2), { authentication: { spf: "softfail", dkim: null, dmarc: null } }));
    fake.inbound.set(id(3), received(id(3)));
    for (const n of [1, 2, 3]) await deliver(id(n));
    expect([await outcome(id(1)), await outcome(id(2)), await outcome(id(3))]).toEqual(["forwarded", "forwarded", "forwarded"]);
    expect(fake.sent.map((m) => m.subject)).toEqual(["[spam?] [skovern.com] Order", "[spam?] [skovern.com] Order", "[skovern.com] Order"]);
    expect(fake.sent[0]?.text.split("\n").slice(0, 2)).toEqual(["From: Rosa <rosa@bloom.test>", "Reply-To: pay@elsewhere.test"]);
    const used = await pool.query<{ kind: string; n: string }>(`SELECT kind, count(*) AS n FROM resend_usage GROUP BY kind ORDER BY kind`);
    // Each flagged forward still costs 2 of the shared quota: received + sent.
    expect(used.rows.map((r) => `${r.kind}=${r.n}`)).toEqual(["flagged=2", "forward=1", "received=3"]);
  });

  it("holds the flagged email past FLAGGED_MAX_PER_DAY (default 2) as held_spam", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const n of [1, 2, 3]) {
      fake.inbound.set(id(n), received(id(n), { authentication: { spf: "fail", dkim: "gray", dmarc: "fail" } }));
      await deliver(id(n));
    }
    expect(fake.sent.filter((m) => m.subject.startsWith("[spam?] "))).toHaveLength(2);
    expect(await outcome(id(3))).toBe("held_spam");
    expect(lines(warn, "flagged cap is used")).toEqual([
      `[inbox] email ${id(3)} may be spoofed (spf fail, dkim gray, dmarc fail) and the flagged cap is used; it stays in Resend`,
    ]);
    // The main cap is untouched: a clean email still goes.
    fake.inbound.set(id(7), received(id(7)));
    await deliver(id(7));
    expect(await outcome(id(7))).toBe("forwarded");
  });

  it("holds flagged mail when the shared quota is spent, says so, and logs the skipped alert", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    deps.quota = { quota: 10, reserve: 2 };
    await pool.query(`INSERT INTO resend_usage (ref, kind) SELECT 'filler/' || g, 'welcome' FROM generate_series(1, 9) g`);
    fake.inbound.set(id(1), received(id(1), { authentication: { spf: "fail", dkim: "fail", dmarc: "fail" } }));
    await deliver(id(1)); // 9 + received = 10: no room for the flagged send, nor the alert
    expect(await outcome(id(1))).toBe("held_spam");
    expect(fake.sent).toHaveLength(0);
    expect(lines(warn, "may be spoofed")).toEqual([
      `[inbox] email ${id(1)} may be spoofed (spf fail, dkim fail, dmarc fail) and the shared Resend budget is spent; it stays in Resend`,
    ]);
    expect(lines(warn, "alert was skipped")).toHaveLength(1);
  });

  it("forwards a flagged email with its attachments, end to end", async () => {
    fake.inbound.set(id(1), received(id(1), {
      authentication: { spf: "gray", dkim: "gray", dmarc: "gray" },
      attachments: [{ id: "a1", filename: "invoice.pdf", content_type: "application/pdf", content_id: null, size: 2048 }],
    }));
    await deliver(id(1));
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({
      from: FROM,
      subject: "[spam?] [skovern.com] Order",
      reply_to: "rosa@bloom.test",
      attachments: [{ filename: "invoice.pdf", path: "https://inbound-cdn.test/a1", content_type: "application/pdf" }],
    });
    expect(await outcome(id(1))).toBe("forwarded");
  });

  it("forwards mail with no authentication data unflagged, with one log line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const [n, auth] of [[1, undefined], [2, null], [3, "pass"], [4, {}]] as const) {
      const over: Record<string, unknown> = { authentication: auth };
      if (auth === undefined) over["authentication"] = undefined;
      fake.inbound.set(id(n), received(id(n), over));
      await deliver(id(n));
    }
    expect(fake.sent.map((m) => m.subject)).toEqual(Array(4).fill("[skovern.com] Order"));
    expect(lines(warn, "no authentication data")).toEqual([1, 2, 3, 4].map((n) => `[inbox] no authentication data on ${id(n)}; forwarding it unflagged`));
  });

  it("reads upper-case results from the API as their lower-case values", async () => {
    fake.inbound.set(id(1), received(id(1), { authentication: { spf: "PASS", dkim: "Pass", dmarc: "NONE" } }));
    fake.inbound.set(id(2), received(id(2), { authentication: { spf: "PASS", dkim: "PASS", dmarc: "FAIL" } }));
    await deliver(id(1));
    await deliver(id(2));
    expect(fake.sent.map((m) => m.subject)).toEqual(["[skovern.com] Order", "[spam?] [skovern.com] Order"]);
  });

  it("S4: holds Auto-Submitted mail as held_auto in either header shape, but forwards Auto-Submitted: no", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    deps.maxPerDay = 1;
    fake.inbound.set(id(1), received(id(1), { headers: { "AuTo-SuBmItTeD": ["auto-replied"] } }));
    fake.inbound.set(id(2), received(id(2), { headers: [{ name: "AUTO-SUBMITTED", value: "auto-generated" }] }));
    fake.inbound.set(id(3), received(id(3), { headers: [{ name: "Auto-Submitted", value: "no" }] }));
    for (const n of [1, 2, 3]) await deliver(id(n));
    expect([await outcome(id(1)), await outcome(id(2)), await outcome(id(3))]).toEqual(["held_auto", "held_auto", "forwarded"]);
    expect(fake.sent).toHaveLength(1);
  });

  it("logs one line when the alert is skipped because the whole quota is used", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    deps.quota = { quota: 10, reserve: 2 };
    await pool.query(`INSERT INTO resend_usage (ref, kind) SELECT 'filler/' || g, 'welcome' FROM generate_series(1, 10) g`);
    for (const n of [1, 2, 3]) {
      fake.inbound.set(id(n), received(id(n)));
      await deliver(id(n));
    }
    expect(fake.sent).toHaveLength(0);
    const skipped = lines(warn, "alert was skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatch(/^\[inbox\] forwarding paused, but the alert was skipped: Resend's daily quota is full \(\d{4}-\d\d-\d\d UTC\)$/);
  });
});

describe("S4: webhook hardening", () => {
  it("answers 400, not 413, and logs when a body read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const req = Object.assign(
      new Readable({
        read() {
          this.destroy(new Error("aborted"));
        },
      }),
      { method: "POST", headers: { "svix-id": "msg_abort1" } },
    ) as unknown as IncomingMessage;
    const r = await handleInboxHook({ key: KEY, store: deps.store, worker, pool, refusals }, req);
    expect(r.status).toBe(400);
    expect(lines(warn, "webhook body read failed")).toEqual(["[inbox] webhook body read failed (aborted), svix-id msg_abort1"]);
    expect(lines(warn, "over limit")).toHaveLength(0);
  });

  it("checks the signature over the raw bytes, even ones that aren't valid UTF-8", async () => {
    fake.inbound.set(id(1), received(id(1)));
    const json = JSON.stringify({ type: "email.received", data: { email_id: id(1), note: "X" } });
    const body = Buffer.from(json, "utf8");
    body[body.indexOf("X")] = 0xff; // a lone 0xff byte: re-encoding it through a string changes it
    expect((await post(body, sign(body))).status).toBe(200);
    expect(await outcome(id(1))).toBe("forwarded");
  });

  it("logs an over-limit body with its svix-id", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const big = Buffer.alloc(300 * 1024, 0x20);
    const r = await post(big, { "svix-id": "msg_toolarge1", "svix-timestamp": "1", "svix-signature": "v1,x" });
    expect(r.status).toBe(413);
    expect(lines(warn, "webhook body over limit")).toEqual(["[inbox] webhook body over limit (262144 bytes), svix-id msg_toolarge1"]);
  });

  it("logs refused signatures as one line a minute, with counts", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = event(id(1));
    for (let i = 0; i < 24; i += 1) await post(body, sign(body, { key: Buffer.from("wrong") }));
    await post(body, { "svix-id": "msg_x" });
    expect(lines(warn, "webhook refused")).toHaveLength(0);
    refusals.flush();
    expect(lines(warn, "webhook refused")).toEqual([
      "[inbox] webhook refused 25 times in the last minute (bad-signature 24, missing 1)",
    ]);
    refusals.flush();
    expect(lines(warn, "webhook refused")).toHaveLength(1);
  });
});

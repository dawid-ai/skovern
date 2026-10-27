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
import { FakeResend } from "../../scripts/smoke/fake-resend.js";

// Loop 052 F1–F7 (and checker B2): the signed Resend webhook in-process, against
// a real Postgres and a fake Resend that serves the Receiving API.

const KEY = Buffer.from("c2tvdmVybi1pbmJveC10ZXN0LWtleS0wMTIz", "base64");
const FORWARD_TO = "dawid@inbox.test";
const ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let on: RunningServer;
let off: RunningServer;
let deps: ForwardDeps;
let worker: InboxWorker;
const fake = new FakeResend();

const received = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  object: "email", id: ID, from: "Rosa <rosa@bloom.test>", to: ["hi@skovern.com"], cc: [], bcc: [], reply_to: [],
  subject: "Do you do weddings?", text: "Hi! June 14, about 80 people.", html: null, headers: {},
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
  deps = { api: { baseUrl: url, apiKey: "re_test" }, store, forwardTo: FORWARD_TO, maxPerDay: 25, quota: { quota: 100, reserve: 15 } };
  worker = new InboxWorker(deps);
  const auth = new AuthService(new AuthStore(pool), new ConsoleMailer(), { appUrl: "http://x" });
  on = await startAuthServer({ service: auth, inbox: { key: KEY, store, worker, pool }, accountRoutes: false, trustProxy: true });
  off = await startAuthServer({ service: auth, accountRoutes: false });
});

afterAll(async () => {
  await worker?.drain();
  await on?.close();
  await off?.close();
  await pool?.end();
  await container?.stop();
  fake.close();
});

beforeEach(async () => {
  fake.reset();
  deps.maxPerDay = 25;
  deps.forwardTo = FORWARD_TO;
  await pool.query("TRUNCATE resend_hook_ids, inbox_mail, resend_usage");
});

let hookSeq = 0;
/** Sign like Svix does, independently of the code under test. */
function signed(body: string, o: { id?: string; at?: number; key?: Buffer } = {}): Record<string, string> {
  const id = o.id ?? `msg_test${(hookSeq += 1)}`;
  const ts = String(Math.floor((o.at ?? Date.now()) / 1000));
  const sig = createHmac("sha256", o.key ?? KEY).update(`${id}.${ts}.${body}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` };
}
const event = (emailId: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: "email.received", created_at: "2026-10-27T10:00:00Z", data: { email_id: emailId, ...extra } });
/** Post to the webhook, then let the worker finish what it queued. */
async function hook(body: string, headers: Record<string, string>, base = on.url): Promise<Response> {
  const r = await fetch(`${base}${HOOK_PATH}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  worker.kick();
  await worker.drain();
  return r;
}
const send = (emailId: string): Promise<Response> => hook(event(emailId), signed(event(emailId)));
const outcome = async (emailId: string): Promise<string | undefined> =>
  (await pool.query<{ outcome: string }>(`SELECT outcome FROM inbox_mail WHERE email_id = $1`, [emailId])).rows[0]?.outcome;

describe("POST /hooks/resend/inbound", () => {
  it("F1: forwards a validly signed email.received to FORWARD_TO, replying to the sender", async () => {
    fake.inbound.set(ID, received());
    const r = await send(ID);
    expect(r.status).toBe(200);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({
      from: "Skovern inbox <inbox@skovern.com>",
      to: FORWARD_TO,
      reply_to: "rosa@bloom.test",
      subject: "[skovern.com] Do you do weddings?",
      key: `forward/${ID}`,
    });
    expect(fake.sent[0]!.text).toContain("To: hi@skovern.com\n\nHi! June 14, about 80 people.");
    expect(await outcome(ID)).toBe("forwarded");
  });

  it("F1: keeps attachments and flags failed SPF with [spam?]", async () => {
    fake.inbound.set(ID, received({
      authentication: { spf: "fail", dkim: "pass", dmarc: "fail" },
      attachments: [{ id: "a1", filename: "quote.pdf", content_type: "application/pdf", content_id: null, size: 1200 }],
    }));
    expect((await send(ID)).status).toBe(200);
    expect(fake.sent[0]?.subject).toBe("[spam?] [skovern.com] Do you do weddings?");
    expect(fake.sent[0]?.attachments).toEqual([{ filename: "quote.pdf", path: "https://inbound-cdn.test/a1", content_type: "application/pdf" }]);
  });

  it("uses the message's own Reply-To when it's one plain outside address, else the sender", async () => {
    const cases: [unknown[], string][] = [
      [["Orders <orders@bloom.test>"], "orders@bloom.test"],
      [["a@bloom.test", "b@bloom.test"], "rosa@bloom.test"],
      [["hi@skovern.com"], "rosa@bloom.test"],
      [["not an address"], "rosa@bloom.test"],
    ];
    for (const [i, [replyTo, want]] of cases.entries()) {
      const id = `33333333-0000-4000-8000-00000000000${i}`;
      fake.inbound.set(id, received({ id, reply_to: replyTo }));
      await send(id);
      expect(fake.sent.at(-1)?.reply_to, JSON.stringify(replyTo)).toBe(want);
    }
  });

  it("F2: refuses a bad signature, a missing header, a stale timestamp, or a tampered body with 401", async () => {
    fake.inbound.set(ID, received());
    const body = event(ID);
    const good = signed(body);
    const cases: [string, Record<string, string>, string][] = [
      ["bad signature", signed(body, { key: Buffer.from("not-the-key") }), body],
      ["missing svix-signature", { ...good, "svix-signature": "" }, body],
      ["missing svix-id", { "svix-timestamp": good["svix-timestamp"]!, "svix-signature": good["svix-signature"]! }, body],
      ["6 minutes stale", signed(body, { at: Date.now() - 6 * 60_000 }), body],
      ["tampered body", good, body.replace(ID, ID.replace("4", "5"))],
    ];
    for (const [label, headers, b] of cases) expect((await hook(b, headers)).status, label).toBe(401);
    expect(fake.sent).toHaveLength(0);
    expect(fake.fetched).toHaveLength(0);
    expect(Number((await pool.query(`SELECT count(*) AS n FROM inbox_mail`)).rows[0].n)).toBe(0);
  });

  it("B2: 25 badly signed requests from one address don't lock out a valid one from it", async () => {
    fake.inbound.set(ID, received());
    const body = event(ID);
    const from = { "x-forwarded-for": "203.0.113.9" };
    for (let i = 0; i < 25; i += 1) {
      expect((await hook(body, { ...signed(body, { key: Buffer.from("wrong") }), ...from })).status).toBe(401);
    }
    expect((await hook(body, { ...signed(body), ...from })).status).toBe(200);
    expect(fake.sent).toHaveLength(1);
  });

  it("F3: a replayed svix-id gets 200 and no second forward", async () => {
    fake.inbound.set(ID, received());
    const body = event(ID);
    const headers = signed(body);
    expect((await hook(body, headers)).status).toBe(200);
    const again = await hook(body, headers);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ duplicate: true });
    // The same email under a new delivery ID (a manual resend) isn't forwarded twice either.
    expect((await hook(body, signed(body))).status).toBe(200);
    expect(fake.sent).toHaveLength(1);
  });

  it("F4: past the cap, holds mail, logs one line each, and sends one alert a day", async () => {
    deps.maxPerDay = 2;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ids = [1, 2, 3, 4].map((n) => `11111111-0000-4000-8000-00000000000${n}`);
    for (const id of ids) {
      fake.inbound.set(id, received({ id }));
      expect((await send(id)).status).toBe(200);
    }
    const alerts = fake.sent.filter((s) => s.subject === "[skovern.com] Forwarding paused for today");
    expect(fake.sent.filter((s) => s.subject.startsWith("[skovern.com] Do you"))).toHaveLength(2);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ to: FORWARD_TO, key: expect.stringMatching(/^summary\/\d{4}-\d{2}-\d{2}$/) });
    expect(alerts[0]!.text).toContain("New mail is waiting in Resend → Emails → Receiving.");
    expect(await outcome(ids[3]!)).toBe("held");
    // Two holds, one alert claimed: the second never reaches Resend at all.
    const claimed = await pool.query(`SELECT count(*) AS n FROM resend_usage WHERE kind = 'summary'`);
    expect(Number(claimed.rows[0].n)).toBe(1);
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("forward budget spent"));
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toMatch(/@/);
    warn.mockRestore();
  });

  it("F5: never forwards mail from a @skovern.com sender", async () => {
    for (const [i, from] of ["hi@skovern.com", "Skovern inbox <inbox@skovern.com>", "x@mail.SKOVERN.com"].entries()) {
      const id = `44444444-0000-4000-8000-00000000000${i}`;
      fake.inbound.set(id, received({ id, from }));
      expect((await send(id)).status).toBe(200);
      expect(await outcome(id)).toBe("skipped");
    }
    expect(fake.sent).toHaveLength(0);
  });

  it("F6: without RESEND_WEBHOOK_SECRET the route is a 404", async () => {
    expect((await hook(event(ID), signed(event(ID)), off.url)).status).toBe(404);
  });

  it("F7: content and recipient come from the Receiving API, never the webhook body", async () => {
    fake.inbound.set(ID, received({ subject: "From the API" }));
    const body = event(ID, { to: ["evil@attacker.test"], from: "boss@bank.test", subject: "From the webhook", forward_to: "evil@attacker.test", text: "pwned" });
    expect((await hook(body, signed(body))).status).toBe(200);
    expect(fake.fetched[0]).toBe(`/emails/receiving/${ID}?html_format=cid`);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ to: FORWARD_TO, subject: "[skovern.com] From the API", reply_to: "rosa@bloom.test" });
    expect(JSON.stringify(fake.sent[0])).not.toMatch(/attacker|pwned|bank\.test/);
  });

  it("never sends to our own domain, even with the config check bypassed", async () => {
    fake.inbound.set(ID, received());
    deps.forwardTo = "hi@skovern.com";
    await send(ID);
    expect(fake.sent).toHaveLength(0);
    expect(await outcome(ID)).toBe("skipped");
  });

  it("resends without attachments, listed by name, when Resend refuses them; gives up on a refused message", async () => {
    fake.inbound.set(ID, received({ attachments: [{ id: "a1", filename: "menu.pdf", content_type: "application/pdf", content_id: null, size: 1200 }] }));
    fake.refuseAttachments = true;
    await send(ID);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ key: `forward/${ID}/names` });
    expect(fake.sent[0]?.attachments).toBeUndefined();
    expect(fake.sent[0]?.text).toContain("- menu.pdf (0.1 MB)");

    const other = "22222222-0000-4000-8000-000000000001";
    fake.inbound.set(other, received({ id: other }));
    fake.sendFaults = [422];
    await send(other);
    expect(await outcome(other)).toBe("refused");
  });

  it("acknowledges a signed event it doesn't handle, and settles an email Resend doesn't have", async () => {
    const other = JSON.stringify({ type: "email.delivered", data: { email_id: ID } });
    expect((await hook(other, signed(other))).status).toBe(200);
    const gone = "99999999-0000-4000-8000-000000000000";
    expect((await send(gone)).status).toBe(200);
    expect(await outcome(gone)).toBe("gone");
    expect(fake.sent).toHaveLength(0);
  });
});

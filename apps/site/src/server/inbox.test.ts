import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService, AuthStore, ConsoleMailer } from "../auth/service.js";
import { startAuthServer, type RunningServer } from "../auth/server.js";
import { HOOK_PATH, type InboxRouteContext } from "../inbox/hook.js";
import { InboxStore } from "../inbox/store.js";
import { WaitlistStore } from "../waitlist/store.js";
import { RateLimiter } from "./rate-limit.js";

// Loop 052 F1–F7: the signed Resend webhook in-process, against a real Postgres
// and a fake Resend that serves the Receiving API and records sends.

const KEY = Buffer.from("c2tvdmVybi1pbmJveC10ZXN0LWtleS0wMTIz", "base64");
const FORWARD_TO = "dawid@inbox.test";
const ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";

interface Sent { from: string; to: string; subject: string; text: string; reply_to?: string; attachments?: { path: string }[] }

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let fake: Server;
let resendUrl: string;
let on: RunningServer;
let off: RunningServer;
let ctx: InboxRouteContext;
const sent: Sent[] = [];
const fetched: string[] = [];
const emails = new Map<string, Record<string, unknown>>();

const received = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  object: "email", id: ID, from: "Rosa <rosa@bloom.test>", to: ["hi@skovern.com"], cc: [], bcc: [], reply_to: [],
  subject: "Do you do weddings?", text: "Hi! June 14, about 80 people.", html: null, headers: {},
  authentication: { spf: "pass", dkim: "pass", dmarc: "pass" }, attachments: [], ...over,
});

beforeAll(async () => {
  fake = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const url = req.url ?? "";
      const m = /^\/emails\/receiving\/([\w-]+)(\/attachments)?(\?.*)?$/.exec(url);
      if (req.method === "GET" && m) {
        fetched.push(url);
        const e = emails.get(m[1]!);
        if (!e) return void res.writeHead(404).end("{}");
        const body = m[2]
          ? { object: "list", has_more: false, data: (e["attachments"] as { id: string }[]).map((a) => ({ ...a, download_url: `https://cdn.test/${a.id}` })) }
          : e;
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
      }
      if (req.method === "POST" && url === "/emails") {
        sent.push(JSON.parse(raw) as Sent);
        return void res.writeHead(200, { "content-type": "application/json" }).end('{"id":"fake"}');
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  resendUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", (err: Error & { code?: string }) => {
    if (err.code !== "57P01") throw err;
  });
  await new AuthStore(pool).migrate();
  await new WaitlistStore(pool).migrate();
  const store = new InboxStore(pool);
  await store.migrate();
  const auth = new AuthService(new AuthStore(pool), new ConsoleMailer(), { appUrl: "http://x" });
  ctx = {
    key: KEY,
    forward: { api: { baseUrl: resendUrl, apiKey: "re_test" }, store, forwardTo: FORWARD_TO, maxPerDay: 25 },
    pool,
    limiter: new RateLimiter(),
    trustProxy: true,
  };
  on = await startAuthServer({ service: auth, inbox: ctx, accountRoutes: false });
  off = await startAuthServer({ service: auth, accountRoutes: false });
});

afterAll(async () => {
  await on?.close();
  await off?.close();
  await pool?.end();
  await container?.stop();
  fake?.close();
});

beforeEach(async () => {
  sent.length = 0;
  fetched.length = 0;
  emails.clear();
  ctx.forward.maxPerDay = 25;
  await pool.query("TRUNCATE resend_hook_ids, inbox_mail, inbox_summaries");
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
function hook(body: string, headers: Record<string, string>, base = on.url): Promise<Response> {
  return fetch(`${base}${HOOK_PATH}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
}

describe("POST /hooks/resend/inbound", () => {
  it("F1: forwards a validly signed email.received to FORWARD_TO, replying to the sender", async () => {
    emails.set(ID, received());
    const body = event(ID);
    const r = await hook(body, signed(body));
    expect(r.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: "Skovern inbox <inbox@skovern.com>",
      to: FORWARD_TO,
      reply_to: "rosa@bloom.test",
      subject: "[skovern.com] Do you do weddings?",
    });
    expect(sent[0]!.text).toContain("To: hi@skovern.com\n\nHi! June 14, about 80 people.");
  });

  it("F1: keeps attachments and flags failed SPF with [spam?]", async () => {
    emails.set(ID, received({
      authentication: { spf: "fail", dkim: "pass", dmarc: "fail" },
      attachments: [{ id: "a1", filename: "quote.pdf", content_type: "application/pdf", content_id: null, size: 1200 }],
    }));
    const body = event(ID);
    expect((await hook(body, signed(body))).status).toBe(200);
    expect(sent[0]?.subject).toBe("[spam?] [skovern.com] Do you do weddings?");
    expect(sent[0]?.attachments).toEqual([{ filename: "quote.pdf", path: "https://cdn.test/a1", content_type: "application/pdf" }]);
  });

  it("F2: refuses a bad signature, a missing header, a stale timestamp, or a tampered body with 401", async () => {
    emails.set(ID, received());
    const body = event(ID);
    const good = signed(body);
    const cases: [string, Record<string, string>, string][] = [
      ["bad signature", signed(body, { key: Buffer.from("not-the-key") }), body],
      ["missing svix-signature", { ...good, "svix-signature": "" }, body],
      ["missing svix-id", { "svix-timestamp": good["svix-timestamp"]!, "svix-signature": good["svix-signature"]! }, body],
      ["6 minutes stale", signed(body, { at: Date.now() - 6 * 60_000 }), body],
      ["tampered body", good, body.replace(ID, ID.replace("4", "5"))],
    ];
    for (const [label, headers, b] of cases) {
      const r = await hook(b, headers);
      expect(r.status, label).toBe(401);
    }
    expect(sent).toHaveLength(0);
    expect(fetched).toHaveLength(0);
  });

  it("F3: a replayed svix-id gets 200 and no second forward", async () => {
    emails.set(ID, received());
    const body = event(ID);
    const headers = signed(body);
    expect((await hook(body, headers)).status).toBe(200);
    const again = await hook(body, headers);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ duplicate: true });
    // The same email under a new delivery ID (a manual resend) isn't forwarded twice either.
    expect((await hook(body, signed(body))).status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("F4: past the cap, holds mail, logs one line each, and sends one summary a day", async () => {
    ctx.forward.maxPerDay = 2;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ids = ["11111111-0000-4000-8000-000000000001", "11111111-0000-4000-8000-000000000002", "11111111-0000-4000-8000-000000000003", "11111111-0000-4000-8000-000000000004"];
    for (const id of ids) {
      emails.set(id, received({ id }));
      const body = event(id);
      expect((await hook(body, signed(body))).status).toBe(200);
    }
    const forwards = sent.filter((s) => s.subject.startsWith("[skovern.com] Do you"));
    const summaries = sent.filter((s) => s.subject.includes("waiting in Resend"));
    expect(forwards).toHaveLength(2);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ to: FORWARD_TO, subject: "[skovern.com] 1 email waiting in Resend" });
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("forward budget spent"));
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toMatch(/@/);
    warn.mockRestore();
  });

  it("F5: never forwards mail from a @skovern.com sender", async () => {
    for (const from of ["hi@skovern.com", "Skovern inbox <inbox@skovern.com>", "x@mail.SKOVERN.com"]) {
      emails.clear();
      emails.set(ID, received({ from }));
      await pool.query("TRUNCATE inbox_mail");
      const body = event(ID);
      expect((await hook(body, signed(body))).status).toBe(200);
    }
    expect(sent).toHaveLength(0);
  });

  it("F6: without RESEND_WEBHOOK_SECRET the route is a 404", async () => {
    const body = event(ID);
    expect((await hook(body, signed(body), off.url)).status).toBe(404);
  });

  it("F7: content and recipient come from the Receiving API, never the webhook body", async () => {
    emails.set(ID, received({ subject: "From the API" }));
    const body = event(ID, { to: ["evil@attacker.test"], from: "boss@bank.test", subject: "From the webhook", forward_to: "evil@attacker.test", text: "pwned" });
    expect((await hook(body, signed(body))).status).toBe(200);
    expect(fetched[0]).toBe(`/emails/receiving/${ID}?html_format=cid`);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: FORWARD_TO, subject: "[skovern.com] From the API", reply_to: "rosa@bloom.test" });
    expect(JSON.stringify(sent[0])).not.toMatch(/attacker|pwned|bank\.test/);
  });

  it("answers 500 and forgets the delivery when Resend is down, so the retry forwards", async () => {
    const body = event(ID);
    const headers = signed(body);
    const realUrl = ctx.forward.api.baseUrl;
    ctx.forward.api.baseUrl = "http://127.0.0.1:1";
    expect((await hook(body, headers)).status).toBe(500);
    ctx.forward.api.baseUrl = realUrl;
    emails.set(ID, received());
    expect((await hook(body, headers)).status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("acknowledges a signed event it doesn't handle, and an email Resend doesn't have", async () => {
    const other = JSON.stringify({ type: "email.delivered", data: { email_id: ID } });
    expect((await hook(other, signed(other))).status).toBe(200);
    const gone = event("99999999-0000-4000-8000-000000000000");
    const r = await hook(gone, signed(gone));
    expect(await r.json()).toMatchObject({ outcome: "gone" });
    expect(sent).toHaveLength(0);
  });
});

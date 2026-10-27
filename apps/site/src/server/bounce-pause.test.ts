import { createHmac } from "node:crypto";
import pg from "pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService, AuthStore, ConsoleMailer } from "../auth/service.js";
import { startAuthServer, type RunningServer } from "../auth/server.js";
import { HOOK_PATH } from "../inbox/hook.js";
import { InboxStore } from "../inbox/store.js";
import { resetPausedLog } from "../waitlist/bounce-pause.js";
import { WaitlistStore } from "../waitlist/store.js";
import { RateLimiter } from "./rate-limit.js";

// Ledger resend-bounce-pause (loop 052 amendment): signed email.bounced and
// email.complained events pause welcome emails past a 5% bounce rate in 24
// hours, once at least 20 went out.

const KEY = Buffer.from("Ym91bmNlLXBhdXNlLXRlc3Qta2V5LTAxMjM0NQ==", "base64");

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let server: RunningServer;
let store: WaitlistStore;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", (err: Error & { code?: string }) => {
    if (err.code !== "57P01") throw err;
  });
  await new AuthStore(pool).migrate();
  store = new WaitlistStore(pool, { perHour: 1000, perDay: 1000 });
  await store.migrate();
  const inbox = new InboxStore(pool);
  await inbox.migrate();
  server = await startAuthServer({
    service: new AuthService(new AuthStore(pool), new ConsoleMailer(), { appUrl: "http://x" }),
    accountRoutes: false,
    inbox: {
      key: KEY,
      forward: { api: { baseUrl: "http://127.0.0.1:1", apiKey: "re_test" }, store: inbox, forwardTo: "d@inbox.test", maxPerDay: 25 },
      pool,
      limiter: new RateLimiter(),
      trustProxy: false,
    },
  });
});

afterAll(async () => {
  await server?.close();
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  resetPausedLog();
  await pool.query("TRUNCATE waitlist CASCADE");
  await pool.query("TRUNCATE waitlist_welcome_sends, mail_feedback, resend_hook_ids");
});

let seq = 0;
async function feedback(type: "email.bounced" | "email.complained", tags: unknown, emailId = `e-${(seq += 1)}`): Promise<number> {
  const body = JSON.stringify({ type, created_at: "2026-10-27T10:00:00Z", data: { email_id: emailId, tags } });
  const id = `msg_bounce${(seq += 1)}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", KEY).update(`${id}.${ts}.${body}`).digest("base64");
  const r = await fetch(`${server.url}${HOOK_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` },
    body,
  });
  return r.status;
}
const sends = (n: number): Promise<unknown> =>
  pool.query(`INSERT INTO waitlist_welcome_sends (sent_at) SELECT now() FROM generate_series(1, $1)`, [n]);
const join = async (): Promise<boolean> => (await store.join(`p${(seq += 1)}@bloom.test`, "Pat")).welcomeClaim !== null;

describe("welcome bounce pause", () => {
  it("keeps sending at 5% (1 of 20) and pauses above it, with one log line", async () => {
    await sends(20);
    expect(await feedback("email.bounced", { kind: "welcome" })).toBe(200);
    expect(await join()).toBe(true);
    expect(await feedback("email.complained", { kind: "welcome" })).toBe(200);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await join()).toBe(false);
    expect(await store.claimBacklog()).toBeNull();
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("welcome emails paused"));
    expect(lines).toEqual(["[waitlist] welcome emails paused: 2 of 21 bounced or complained in 24 hours (9.5%)"]);
    warn.mockRestore();
    // Saved anyway: the person is on the list, their welcome waiting.
    expect((await store.list()).at(-1)?.welcome).toBe("waiting");
  });

  it("doesn't pause under 20 sends, however many bounce", async () => {
    await sends(10);
    for (let i = 0; i < 5; i += 1) await feedback("email.bounced", { kind: "welcome" });
    expect(await join()).toBe(true);
  });

  it("counts only welcome bounces, each email once, and only in the last 24 hours", async () => {
    await sends(20);
    await feedback("email.bounced", { kind: "forward" });
    await feedback("email.bounced", null);
    await feedback("email.bounced", [{ name: "kind", value: "welcome" }], "same");
    await feedback("email.complained", { kind: "welcome" }, "same");
    await feedback("email.bounced", { kind: "welcome" }, "old");
    await pool.query(`UPDATE mail_feedback SET at = now() - interval '25 hours' WHERE email_id = 'old'`);
    expect(await join()).toBe(true);
  });

  it("refuses an unsigned bounce", async () => {
    const r = await fetch(`${server.url}${HOOK_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "email.bounced", data: { email_id: "x", tags: { kind: "welcome" } } }),
    });
    expect(r.status).toBe(401);
    expect(Number((await pool.query(`SELECT count(*) AS n FROM mail_feedback`)).rows[0].n)).toBe(0);
  });
});

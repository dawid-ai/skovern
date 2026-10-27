import { createHmac } from "node:crypto";
import pg from "pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService, AuthStore, ConsoleMailer } from "../auth/service.js";
import { startAuthServer, type RunningServer } from "../auth/server.js";
import { HOOK_PATH } from "../inbox/hook.js";
import { InboxStore } from "../inbox/store.js";
import { InboxWorker } from "../inbox/worker.js";
import { resetPausedLog } from "../waitlist/bounce-pause.js";
import { WaitlistStore } from "../waitlist/store.js";
import { ResendWelcomeMailer } from "../waitlist/mail.js";
import { deliverWelcome } from "../waitlist/welcome.js";
import { welcomeBounceStats } from "../waitlist/bounce-pause.js";
import { FakeResend } from "../../scripts/smoke/fake-resend.js";

// Ledger resend-bounce-pause (loop 052 amendment): signed email.bounced,
// email.complained, and email.suppressed events pause welcome emails past a 5%
// rate among the last 24 hours' welcomes (at least 20), matched by email ID.
// Plus the shared Resend quota's hold on welcomes (B1).

const KEY = Buffer.from("Ym91bmNlLXBhdXNlLXRlc3Qta2V5LTAxMjM0NQ==", "base64");

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let server: RunningServer;
let store: WaitlistStore;
const fake = new FakeResend();
let fakeUrl = "";

beforeAll(async () => {
  fakeUrl = (await fake.listen()).url;
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
      store: inbox,
      worker: new InboxWorker({
        api: { baseUrl: "http://127.0.0.1:1", apiKey: "re_test" },
        store: inbox,
        forwardTo: "d@inbox.test",
        maxPerDay: 25,
        quota: { quota: 100, reserve: 15 },
      }),
      pool,
    },
  });
});

afterAll(async () => {
  await server?.close();
  await pool?.end();
  await container?.stop();
  fake.close();
});

beforeEach(async () => {
  resetPausedLog();
  await pool.query("TRUNCATE waitlist CASCADE");
  await pool.query("TRUNCATE waitlist_welcome_sends, mail_feedback, resend_hook_ids, resend_usage");
});

let seq = 0;
type Kind = "email.bounced" | "email.complained" | "email.suppressed";
async function feedback(type: Kind, emailId: string): Promise<number> {
  const body = JSON.stringify({ type, created_at: "2026-10-27T10:00:00Z", data: { email_id: emailId, tags: { kind: "welcome" } } });
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
/** Log `n` welcome sends with Resend IDs w1..wn, `hoursAgo` back. */
const sends = (n: number, hoursAgo = 0): Promise<unknown> =>
  pool.query(
    `INSERT INTO waitlist_welcome_sends (sent_at, resend_id)
     SELECT now() - ($2 || ' hours')::interval, 'w' || g FROM generate_series(1, $1) g`,
    [n, String(hoursAgo)],
  );
const join = async (): Promise<boolean> => (await store.join(`p${(seq += 1)}@bloom.test`, "Pat")).welcomeClaim !== null;

describe("welcome bounce pause", () => {
  it("keeps sending at 5% (1 of 20) and pauses above it, with one log line", async () => {
    await sends(20);
    expect(await feedback("email.bounced", "w1")).toBe(200);
    expect(await join()).toBe(true);
    expect(await feedback("email.complained", "w2")).toBe(200);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await join()).toBe(false);
    expect(await store.claimBacklog()).toBeNull();
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("welcome emails paused"));
    expect(lines).toEqual(["[waitlist] welcome emails paused: 2 of 21 bounced, complained, or were suppressed in 24 hours (9.5%)"]);
    warn.mockRestore();
    // Saved anyway: the person is on the list, their welcome waiting.
    expect((await store.list()).at(-1)?.welcome).toBe("waiting");
  });

  it("counts suppressions too", async () => {
    await sends(20);
    await feedback("email.suppressed", "w1");
    await feedback("email.suppressed", "w2");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await join()).toBe(false);
    vi.restoreAllMocks();
  });

  it("doesn't pause under 20 sends, however many bounce", async () => {
    await sends(10);
    for (let i = 1; i <= 5; i += 1) await feedback("email.bounced", `w${i}`);
    expect(await join()).toBe(true);
  });

  it("counts only events for welcomes sent in the window, each email once", async () => {
    await sends(20);
    await pool.query(`INSERT INTO waitlist_welcome_sends (sent_at, resend_id) VALUES (now() - interval '25 hours', 'old')`);
    await feedback("email.bounced", "not-a-welcome");
    await feedback("email.bounced", "old");
    await feedback("email.bounced", "w1");
    await feedback("email.complained", "w1");
    expect(await join()).toBe(true);
  });

  it("pauses on a bounce of a welcome really sent through Resend, matched by the ID it returned", async () => {
    fake.reset();
    await sends(20);
    await feedback("email.bounced", "w1");
    const mailer = new ResendWelcomeMailer("re_test", "Skovern <hi@skovern.com>", fakeUrl);
    const joined = await store.join("real@bloom.test", "Rae");
    expect(joined.welcomeClaim).not.toBeNull();
    const delivered = await deliverWelcome(
      { store, mailer, appUrl: () => "https://api.test" },
      { id: joined.id, email: "real@bloom.test", name: "Rae", number: joined.number, claim: joined.welcomeClaim! },
    );
    expect(delivered).toBe("sent");
    expect(fake.sent).toHaveLength(1);
    expect(await feedback("email.bounced", "fake-1")).toBe(200);
    expect(await welcomeBounceStats(pool)).toEqual({ sends: 21, bad: 2 });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await join()).toBe(false);
    vi.restoreAllMocks();
  });

  it("records Resend's ID for a sent welcome, so its bounce is matched", async () => {
    const joined = await store.join("ids@bloom.test", "Ida");
    await store.recordWelcomeId(joined.welcomeClaim!, "re-123");
    const row = await pool.query(`SELECT resend_id FROM waitlist_welcome_sends WHERE id = $1`, [joined.welcomeClaim]);
    expect(row.rows[0].resend_id).toBe("re-123");
  });

  it("refuses an unsigned bounce", async () => {
    const r = await fetch(`${server.url}${HOOK_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "email.bounced", data: { email_id: "w1" } }),
    });
    expect(r.status).toBe(401);
    expect(Number((await pool.query(`SELECT count(*) AS n FROM mail_feedback`)).rows[0].n)).toBe(0);
  });
});

describe("welcomes under the shared Resend quota", () => {
  const filler = (n: number): Promise<unknown> =>
    pool.query(`INSERT INTO resend_usage (ref, kind) SELECT 'filler/' || g, 'received' FROM generate_series(1, $1) g`, [n]);

  it("stop once total use reaches quota minus reserve, and count each welcome", async () => {
    const tight = new WaitlistStore(pool, { perHour: 1000, perDay: 1000, quota: { quota: 10, reserve: 2 } });
    await filler(6);
    expect((await tight.join("q1@bloom.test", "Q")).welcomeClaim).not.toBeNull(); // 6 used → 7
    expect((await tight.join("q2@bloom.test", "Q")).welcomeClaim).not.toBeNull(); // 7 used → 8
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await tight.join("q3@bloom.test", "Q")).welcomeClaim).toBeNull(); // 8 = 10 - 2
    expect(await tight.claimBacklog()).toBeNull();
    vi.restoreAllMocks();
    const kinds = await pool.query(`SELECT count(*) AS n FROM resend_usage WHERE kind = 'welcome'`);
    expect(Number(kinds.rows[0].n)).toBe(2);
  });

  it("hands the slot back in both budgets when a send fails", async () => {
    const joined = await store.join("back@bloom.test", "B");
    await store.releaseWelcome(joined.id, joined.welcomeClaim!);
    const left = await pool.query(`SELECT count(*) AS n FROM resend_usage WHERE ref = $1`, [`welcome/${joined.welcomeClaim}`]);
    expect(Number(left.rows[0].n)).toBe(0);
  });
});

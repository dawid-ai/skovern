import pg from "pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuthService, AuthStore, ConsoleMailer } from "../auth/service.js";
import { startAuthServer, type RunningServer } from "../auth/server.js";
import type { Welcome, WelcomeMailer } from "../waitlist/mail.js";
import { MailError } from "../auth/mailer.js";
import { resetBudgetLog } from "../waitlist/welcome-budget.js";
import { WaitlistStore } from "../waitlist/store.js";
import { RateLimiter } from "./rate-limit.js";
import { sendWelcomeBacklog, sweepExpired } from "./sweep.js";
import { handleJoin } from "../waitlist/handlers.js";

// The waitlist API in-process against a real Postgres: signup, repeat, details,
// remove (GET confirms, POST deletes), admin auth, CORS, the per-IP limit, and
// the expiry sweep.

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let server: RunningServer;
let store: WaitlistStore;
// A slow mail service (like a real one), so two joins overlap while it "sends".
class SlowMailer implements WelcomeMailer {
  readonly sent: { to: string; welcome: Welcome }[] = [];
  failNext = false;
  /** Addresses the "mail service" refuses with a 422, like a bad mailbox. */
  readonly refuse = new Set<string>();
  /** When set, every send fails with this status (an outage, a bad key, a quota). */
  failWith: number | undefined = undefined;
  async sendWelcome(to: string, welcome: Welcome): Promise<void> {
    await new Promise((r) => setTimeout(r, 300));
    if (this.failNext) {
      this.failNext = false;
      throw new MailError(503);
    }
    if (this.refuse.has(to)) throw new MailError(422);
    if (this.failWith !== undefined) throw new MailError(this.failWith);
    this.sent.push({ to, welcome });
  }
}
const mailer = new SlowMailer();
const ADMIN = "admin-token-for-tests";
let ipSeq = 0;
const freshIp = (): string => `198.51.100.${(ipSeq += 1)}`;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  // When the container stops, Postgres ends idle clients with 57P01 (admin
  // shutdown); without a listener that error is unhandled and fails the run after
  // the tests pass. Anything else is a real problem, so it still throws.
  pool.on("error", (err: Error & { code?: string }) => {
    if (err.code !== "57P01") throw err;
  });
  await new AuthStore(pool).migrate();
  store = new WaitlistStore(pool, { perHour: 1000, perDay: 1000 });
  await store.migrate();
  const auth = new AuthService(new AuthStore(pool), new ConsoleMailer(), { appUrl: "http://x" });
  const limiter = new RateLimiter();
  server = await startAuthServer({
    service: auth,
    adminToken: ADMIN,
    limiter,
    trustProxy: true,
    waitlist: {
      deps: { store, mailer, appUrl: () => "https://api.test" },
      limiter,
      trustProxy: true,
      corsOrigins: ["https://skovern.com"],
      adminToken: ADMIN,
      siteUrl: "https://skovern.com",
    },
  });
});

afterAll(async () => {
  await server?.close();
  await pool?.end();
  await container?.stop();
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": freshIp(), ...headers },
    body: JSON.stringify(body),
  });
}

describe("waitlist API", () => {
  it("signs up, repeats with the same number and no second email, saves details", async () => {
    const r1 = await post("/api/waitlist", { name: "Rosa", email: "Rosa@Bloom.shop" });
    expect(r1.status).toBe(201);
    const a = (await r1.json()) as { number: number; detailsToken: string };
    expect(a.number).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.welcome.removeUrl).toMatch(/^https:\/\/api\.test\/waitlist\/remove\?t=[\w-]{43}$/);

    const r2 = await post("/api/waitlist", { name: "Rosa D", email: "rosa@bloom.shop" });
    const b = (await r2.json()) as { number: number; detailsToken: string };
    expect(b.number).toBe(1);
    expect(b.detailsToken).not.toBe(a.detailsToken);
    expect(mailer.sent).toHaveLength(1);

    const d = await post("/api/waitlist/details", {
      detailsToken: a.detailsToken,
      jobTitle: "Owner",
      businessType: "florist",
      url: "bloom.shop",
    });
    expect(d.status).toBe(204);
    const [row] = await store.list();
    expect(row).toMatchObject({ number: 1, name: "Rosa", jobTitle: "Owner", businessType: "florist", url: "https://bloom.shop" });
  });

  it("sends one welcome when the same new address joins twice at once", async () => {
    const before = mailer.sent.length;
    const [a, b] = await Promise.all([
      post("/api/waitlist", { name: "Kim", email: "race@bloom.shop" }),
      post("/api/waitlist", { name: "Kim", email: "race@bloom.shop" }),
    ]);
    const na = ((await a.json()) as { number: number }).number;
    const nb = ((await b.json()) as { number: number }).number;
    expect(na).toBe(nb);
    expect(mailer.sent.slice(before).filter((m) => m.to === "race@bloom.shop")).toHaveLength(1);
  });

  it("hands the welcome back when the send fails, so the next join retries", async () => {
    mailer.failNext = true;
    await post("/api/waitlist", { name: "Ade", email: "retry@bloom.shop" });
    expect(mailer.sent.some((m) => m.to === "retry@bloom.shop")).toBe(false);
    await post("/api/waitlist", { name: "Ade", email: "retry@bloom.shop" });
    expect(mailer.sent.filter((m) => m.to === "retry@bloom.shop")).toHaveLength(1);
  });

  it("keeps the first step-2 answers when a later token tries to change them", async () => {
    const first = (await (await post("/api/waitlist", { name: "Sam", email: "keep@bloom.shop" })).json()) as { detailsToken: string };
    expect((await post("/api/waitlist/details", { detailsToken: first.detailsToken, jobTitle: "Owner" })).status).toBe(204);
    const again = (await (await post("/api/waitlist", { name: "Sam", email: "keep@bloom.shop" })).json()) as { detailsToken: string };
    expect(
      (await post("/api/waitlist/details", { detailsToken: again.detailsToken, jobTitle: "PWNED", businessType: "cafe" })).status,
    ).toBe(204);
    const row = (await store.list()).find((x) => x.email === "keep@bloom.shop");
    // A repeat join's token is a decoy: accepted, and it writes nothing at all.
    expect(row).toMatchObject({ jobTitle: "Owner", businessType: null });
  });

  it("gives step 2 only to the first join; a repeat join's token saves nothing", async () => {
    const first = (await (await post("/api/waitlist", { name: "Ida", email: "first-only@bloom.shop" })).json()) as { detailsToken: string };
    const repeat = (await (await post("/api/waitlist", { name: "Ida", email: "first-only@bloom.shop" })).json()) as { detailsToken: string };
    expect(repeat.detailsToken).toMatch(/^[\w-]{43}$/);
    expect((await post("/api/waitlist/details", { detailsToken: repeat.detailsToken, jobTitle: "Spoofed" })).status).toBe(204);
    let row = (await store.list()).find((x) => x.email === "first-only@bloom.shop");
    expect(row?.jobTitle).toBeNull();
    expect((await post("/api/waitlist/details", { detailsToken: first.detailsToken, jobTitle: "Owner" })).status).toBe(204);
    row = (await store.list()).find((x) => x.email === "first-only@bloom.shop");
    expect(row?.jobTitle).toBe("Owner");
  });

  it("sends a no-JS form to the done page only on success", async () => {
    const form = async (body: string, ip: string): Promise<string | null> =>
      (
        await fetch(`${server.url}/api/waitlist`, {
          method: "POST",
          redirect: "manual",
          headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
          body,
        })
      ).headers.get("location");
    expect(await form("name=Nia&email=nia%40bloom.shop", freshIp())).toMatch(/^https:\/\/skovern\.com\/waitlist\/done\/\?n=\d+$/);
    expect(await form("name=Nia&email=nia%40bloom", freshIp())).toBe("https://skovern.com/waitlist/oops/?error=email");
    const ip = "192.0.2.200";
    const spent: (string | null)[] = [];
    for (let i = 0; i < 4; i += 1) spent.push(await form("name=&email=", ip));
    expect(spent.slice(0, 3).every((l) => l === "https://skovern.com/waitlist/oops/?error=name")).toBe(true);
    expect(spent[3]).toBe("https://skovern.com/waitlist/oops/?error=busy");
  });

  it("refuses a foreign Origin on the JSON and the form path", async () => {
    const json = await post("/api/waitlist", { name: "Eve", email: "eve@evil.test" }, { origin: "https://evil.test" });
    expect(json.status).toBe(403);
    expect(json.headers.get("access-control-allow-origin")).toBeNull();
    const details = await post("/api/waitlist/details", { detailsToken: "a".repeat(43), jobTitle: "x" }, { origin: "https://evil.test" });
    expect(details.status).toBe(403);
    const form = await fetch(`${server.url}/api/waitlist`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.test", "x-forwarded-for": freshIp() },
      body: "name=Eve&email=eve%40evil.test",
    });
    expect(form.status).toBe(403);
    expect((await store.list()).some((x) => x.email === "eve@evil.test")).toBe(false);
  });

  it.each([
    ["/api/waitlist", "text/plain"],
    ["/api/waitlist", ""],
    ["/api/waitlist/details", "text/plain"],
    ["/api/waitlist/details", "application/x-www-form-urlencoded"],
  ])("answers %s with %j as 415", async (path, type) => {
    const r = await fetch(`${server.url}${path}`, {
      method: "POST",
      headers: { ...(type ? { "content-type": type } : {}), "x-forwarded-for": freshIp() },
      body: JSON.stringify({ name: "Tim", email: "tim@bloom.shop" }),
    });
    expect(r.status).toBe(415);
  });

  it("stores nothing when the honeypot is filled", async () => {
    const before = (await store.list()).length;
    const r = await post("/api/waitlist", { name: "Bot", email: "bot@spam.biz", company_website: "spam.biz" });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { number: number }).number).toBeGreaterThan(0);
    expect((await store.list()).length).toBe(before);
  });

  it("removes only on POST, and kills the details token with it", async () => {
    const r = await post("/api/waitlist", { name: "Lee", email: "lee@bakery.test" });
    const { detailsToken } = (await r.json()) as { detailsToken: string };
    const link = new URL(mailer.sent.at(-1)!.welcome.removeUrl);
    const t = link.searchParams.get("t")!;

    const page = await fetch(`${server.url}/waitlist/remove?t=${t}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Remove me");
    expect((await store.list()).some((x) => x.email === "lee@bakery.test")).toBe(true);

    const del = await fetch(`${server.url}/waitlist/remove`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `t=${t}`,
    });
    expect(del.status).toBe(200);
    expect(await del.text()).toContain("You're off the list.");
    expect((await store.list()).some((x) => x.email === "lee@bakery.test")).toBe(false);

    const again = await post("/api/waitlist/details", { detailsToken, jobTitle: "Baker" });
    expect(again.status).toBe(400);
    expect(((await again.json()) as { field: string }).field).toBe("detailsToken");
  });

  it("guards the admin view and CSV with the admin token", async () => {
    expect((await fetch(`${server.url}/admin/waitlist`)).status).toBe(401);
    const auth = { authorization: `Basic ${Buffer.from(`x:${ADMIN}`).toString("base64")}` };
    const html = await fetch(`${server.url}/admin/waitlist`, { headers: auth });
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("Florist");
    const csv = await fetch(`${server.url}/admin/waitlist.csv`, { headers: auth });
    expect(csv.headers.get("content-type")).toContain("text/csv");
  });

  it("sends CORS headers only to allowed origins", async () => {
    const ok = await fetch(`${server.url}/api/waitlist`, { method: "OPTIONS", headers: { origin: "https://skovern.com" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://skovern.com");
    const bad = await fetch(`${server.url}/api/waitlist`, { method: "OPTIONS", headers: { origin: "https://evil.test" } });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("limits per IP on the rightmost X-Forwarded-For entry", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await post("/api/waitlist", { name: "", email: "" }, { "x-forwarded-for": `10.9.9.${i}, 203.0.113.7` });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 3).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(3)).toEqual([429, 429]);
  });
});

describe("sweepExpired", () => {
  it("deletes expired detail tokens, sessions, and old magic links, and keeps live ones", async () => {
    const { id } = await store.join("sweep@shop.test", "Sweep");
    await store.issueToken(id, "details");
    await store.issueToken(id, "remove");
    await pool.query(`UPDATE waitlist_tokens SET expires_at = now() - interval '1 minute'
                       WHERE waitlist_id = $1 AND kind = 'details'`, [id]);
    await pool.query(`INSERT INTO magic_tokens (id, secret_hash, email, expires_at)
                      VALUES ('old', 'h', 'a@b.co', now() - interval '2 days'), ('new', 'h', 'a@b.co', now() + interval '5 minutes')`);
    const counts = await sweepExpired(pool);
    expect(counts.waitlistTokens).toBeGreaterThanOrEqual(1);
    expect(counts.magicTokens).toBe(1);
    const left = await pool.query(`SELECT kind FROM waitlist_tokens WHERE waitlist_id = $1`, [id]);
    expect(left.rows.map((r: { kind: string }) => r.kind)).toEqual(["remove"]);
    const magic = await pool.query(`SELECT id FROM magic_tokens`);
    expect(magic.rows.map((r: { id: string }) => r.id)).toEqual(["new"]);
  });
});

describe("failure-only limits", () => {
  it("locks an address out of admin after 10 wrong passwords, even with the right one", async () => {
    const ip = "192.0.2.77";
    const tryAdmin = (pw: string) =>
      fetch(`${server.url}/admin/waitlist`, {
        headers: { authorization: `Basic ${Buffer.from(`x:${pw}`).toString("base64")}`, "x-forwarded-for": ip },
      }).then((r) => r.status);
    expect(await tryAdmin(ADMIN)).toBe(200);
    for (let i = 0; i < 10; i += 1) expect(await tryAdmin("wrong")).toBe(401);
    expect(await tryAdmin(ADMIN)).toBe(429);
    // Another address is unaffected.
    expect(
      await fetch(`${server.url}/admin/waitlist`, {
        headers: { authorization: `Basic ${Buffer.from(`x:${ADMIN}`).toString("base64")}`, "x-forwarded-for": "192.0.2.78" },
      }).then((r) => r.status),
    ).toBe(200);
  });

  it("never refuses working one-click removes from one address; dead links count", async () => {
    const ip = "192.0.2.90";
    const remove = (t: string) =>
      fetch(`${server.url}/waitlist/remove?t=${t}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
        body: "List-Unsubscribe=One-Click",
      }).then((r) => r.status);
    for (let i = 0; i < 25; i += 1) {
      const { id } = await store.join(`unsub-${i}@bloom.shop`, "Una");
      expect(await remove(await store.issueToken(id, "remove"))).toBe(200);
    }
    const dead: number[] = [];
    for (let i = 0; i < 21; i += 1) dead.push(await remove("x".repeat(43)));
    expect(dead.slice(0, 20).every((st) => st === 404)).toBe(true);
    expect(dead[20]).toBe(429);
    // The dead-link page names no mailbox that can't receive mail yet.
    const page = await (await fetch(`${server.url}/waitlist/remove?t=${"y".repeat(43)}`)).text();
    expect(page).toContain("This link doesn't work anymore.");
    expect(page).not.toMatch(/mailto:|@skovern\.com/);
  });
});

describe("account routes off (production before the beta)", () => {
  it("mounts only /healthz and the waitlist", async () => {
    const auth = new AuthService(new AuthStore(pool), new ConsoleMailer(), { appUrl: "http://x" });
    const limiter = new RateLimiter();
    const off = await startAuthServer({
      service: auth,
      adminToken: ADMIN,
      accountRoutes: false,
      waitlist: {
        deps: { store, mailer, appUrl: () => "https://api.test" },
        limiter,
        trustProxy: false,
        corsOrigins: ["https://skovern.com"],
        adminToken: ADMIN,
        siteUrl: "https://skovern.com",
      },
    });
    try {
      const gone = [
        ["POST", "/auth/request"], ["POST", "/auth/verify"], ["POST", "/dm"], ["GET", "/dm/thread"], ["POST", "/dm/read"],
        ["POST", "/publish/visibility"], ["GET", "/u/visibility/x/og.png"], ["GET", "/u/news/x"], ["GET", "/news"],
        ["GET", "/admin/dm"], ["POST", "/admin/dm/reply"], ["POST", "/admin/news"],
      ] as const;
      for (const [method, path] of gone) {
        const r = await fetch(`${off.url}${path}`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
        expect(r.status, `${method} ${path}`).toBe(404);
      }
      expect((await fetch(`${off.url}/healthz`)).status).toBe(200);
      const auth401 = await fetch(`${off.url}/admin/waitlist`);
      expect(auth401.status).toBe(401);
    } finally {
      await off.close();
    }
  });
});

describe("welcome email budget", () => {
  /** A clean slate: no recent sends, nothing waiting. */
  const reset = async (): Promise<void> => {
    await pool.query("TRUNCATE waitlist_welcome_sends");
    await pool.query(`UPDATE waitlist SET welcome_sent_at = now() WHERE welcome_sent_at IS NULL AND welcome_skipped IS NULL`);
  };
  /** A saved signup that is waiting for its welcome, `ageHours` old. */
  const waiting = async (email: string, ageHours = 0): Promise<void> => {
    // Written straight to the table, so it uses no budget slot of its own.
    await pool.query(
      `INSERT INTO waitlist (email, name, created_at) VALUES ($1, 'Wai', now() - ($2 || ' hours')::interval)`,
      [email, String(ageHours)],
    );
  };
  const welcomeOf = async (email: string): Promise<string | undefined> =>
    (await store.list()).find((x) => x.email === email)?.welcome;

  it("saves a signup over budget without sending, and logs one line", async () => {
    await reset();
    resetBudgetLog();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tight = new WaitlistStore(pool, { perHour: 1, perDay: 90 });
      const deps = { store: tight, mailer, appUrl: () => "https://api.test" };
      const before = mailer.sent.length;
      const a = await handleJoin(deps, { name: "Una", email: "budget-a@bloom.shop" });
      const b = await handleJoin(deps, { name: "Bo", email: "budget-b@bloom.shop" });
      const c = await handleJoin(deps, { name: "Cy", email: "budget-c@bloom.shop" });
      expect([a.status, b.status, c.status]).toEqual([201, 201, 201]);
      expect(mailer.sent.slice(before).map((m) => m.to)).toEqual(["budget-a@bloom.shop"]);
      expect(await welcomeOf("budget-b@bloom.shop")).toBe("waiting");
      const lines = warn.mock.calls.map((args) => String(args[0]));
      expect(lines).toEqual(["[waitlist] welcome budget spent; 1 waiting"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("never sends backlog junk older than a day, and sends fresh signups newest first", async () => {
    await reset();
    const deps = { store, mailer, appUrl: () => "https://api.test" };
    await waiting("junk-old@flood.test", 30);
    await waiting("fresh-1@bloom.shop", 2);
    await waiting("fresh-2@bloom.shop", 1);
    const before = mailer.sent.length;
    expect(await sendWelcomeBacklog(deps)).toBe(2);
    expect(mailer.sent.slice(before).map((m) => m.to)).toEqual(["fresh-2@bloom.shop", "fresh-1@bloom.shop"]);
    expect(await welcomeOf("junk-old@flood.test")).toBe("expired");
  });

  it("skips an address the mail service refuses (4xx) and keeps going", async () => {
    await reset();
    const deps = { store, mailer, appUrl: () => "https://api.test" };
    await waiting("behind@bloom.shop", 2);
    await waiting("poison@bloom.shop", 1);
    mailer.refuse.add("poison@bloom.shop");
    try {
      expect(await sendWelcomeBacklog(deps)).toBe(1);
      expect(mailer.sent.at(-1)?.to).toBe("behind@bloom.shop");
      expect(await welcomeOf("poison@bloom.shop")).toBe("refused");
      // The refusal gave its budget slot back.
      expect((await pool.query(`SELECT count(*)::int AS n FROM waitlist_welcome_sends`)).rows[0].n).toBe(1);
      // And a later run doesn't try it again.
      expect(await sendWelcomeBacklog(deps)).toBe(0);
    } finally {
      mailer.refuse.clear();
    }
  });

  it.each([401, 403, 429])("stops on %i and leaves every row waiting", async (status) => {
    await reset();
    const deps = { store, mailer, appUrl: () => "https://api.test" };
    for (let i = 0; i < 3; i += 1) await waiting(`pending-${status}-${i}@bloom.shop`, 1);
    const before = mailer.sent.length;
    mailer.failWith = status;
    try {
      expect(await sendWelcomeBacklog(deps)).toBe(0);
    } finally {
      mailer.failWith = undefined;
    }
    expect(mailer.sent.length).toBe(before);
    for (let i = 0; i < 3; i += 1) expect(await welcomeOf(`pending-${status}-${i}@bloom.shop`)).toBe("waiting");
    // Nothing used a budget slot, and the next run sends them all.
    expect((await pool.query(`SELECT count(*)::int AS n FROM waitlist_welcome_sends`)).rows[0].n).toBe(0);
    expect(await sendWelcomeBacklog(deps)).toBe(3);
  });

  it("never marks a live join refused during a 429, and the next sweep sends it", async () => {
    await reset();
    const deps = { store, mailer, appUrl: () => "https://api.test" };
    mailer.failWith = 429;
    try {
      expect((await handleJoin(deps, { name: "Rosa", email: "quota@bloom.shop" })).status).toBe(201);
    } finally {
      mailer.failWith = undefined;
    }
    expect(await welcomeOf("quota@bloom.shop")).toBe("waiting");
    expect(await sendWelcomeBacklog(deps)).toBe(1);
    expect(mailer.sent.at(-1)?.to).toBe("quota@bloom.shop");
  });

  it("keeps a refused address refused for a day, then lets a repeat join retry it", async () => {
    await reset();
    const deps = { store, mailer, appUrl: () => "https://api.test" };
    mailer.refuse.add("typo@bloom.shop");
    await handleJoin(deps, { name: "Ty", email: "typo@bloom.shop" });
    mailer.refuse.clear();
    expect(await welcomeOf("typo@bloom.shop")).toBe("refused");
    await handleJoin(deps, { name: "Ty", email: "typo@bloom.shop" });
    expect(await welcomeOf("typo@bloom.shop")).toBe("refused");
    await pool.query(`UPDATE waitlist SET welcome_skipped_at = now() - interval '25 hours' WHERE email = 'typo@bloom.shop'`);
    await handleJoin(deps, { name: "Ty", email: "typo@bloom.shop" });
    expect(await welcomeOf("typo@bloom.shop")).toBe("sent");
    expect(mailer.sent.at(-1)?.to).toBe("typo@bloom.shop");
  });

  it("keeps half the hour for live joins while the backlog is full", async () => {
    await reset();
    const tight = new WaitlistStore(pool, { perHour: 4, perDay: 90 });
    const deps = { store: tight, mailer, appUrl: () => "https://api.test" };
    for (let i = 0; i < 5; i += 1) await waiting(`flood-${i}@flood.test`, 1);
    const before = mailer.sent.length;
    // The backlog may take 2 of the 4 hourly slots, then stops.
    expect(await sendWelcomeBacklog(deps)).toBe(2);
    expect(await sendWelcomeBacklog(deps)).toBe(0);
    // A person joining now still gets a welcome.
    await handleJoin(deps, { name: "Rosa", email: "live@bloom.shop" });
    expect(mailer.sent.slice(before).map((m) => m.to)).toContain("live@bloom.shop");
    expect(await welcomeOf("live@bloom.shop")).toBe("sent");
  });

  it("puts a failed send (5xx) back in the backlog, and the backlog retries it", async () => {
    await reset();
    const deps = { store, mailer, appUrl: () => "https://api.test" };
    mailer.failNext = true;
    await handleJoin(deps, { name: "Flo", email: "retry-later@bloom.shop" });
    expect(mailer.sent.some((m) => m.to === "retry-later@bloom.shop")).toBe(false);
    expect((await pool.query(`SELECT count(*)::int AS n FROM waitlist_welcome_sends`)).rows[0].n).toBe(0);
    expect(await welcomeOf("retry-later@bloom.shop")).toBe("waiting");
    expect(await sendWelcomeBacklog(deps)).toBe(1);
    expect(mailer.sent.at(-1)?.to).toBe("retry-later@bloom.shop");
  });
});

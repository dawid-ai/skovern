import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";
import { limitFailures, RateLimiter } from "./rate-limit.js";
import { clientIp, limitKey } from "../http.js";
import { pickMailers } from "./mailers.js";
import { LruCache } from "../publish/og-cache.js";

const PROD = {
  NODE_ENV: "production",
  RESEND_API_KEY: "re_test",
  APP_URL: "https://api.skovern.com",
  DATABASE_URL: "postgres://u:p@db/x",
};

describe("loadConfig", () => {
  it.each(["RESEND_API_KEY", "APP_URL", "DATABASE_URL"])("refuses a production boot without %s", (k) => {
    const env = { ...PROD, [k]: "" };
    expect(() => loadConfig(env)).toThrow(new RegExp(`Missing required setting in production: ${k}`));
  });

  it("names every missing setting at once", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(
      "Missing required settings in production: RESEND_API_KEY, APP_URL, DATABASE_URL",
    );
  });

  it("requires https and a bare origin for APP_URL in production", () => {
    expect(() => loadConfig({ ...PROD, APP_URL: "http://api.skovern.com" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...PROD, APP_URL: "https://api.skovern.com/x" })).toThrow(/bare origin/);
  });

  it("allows only the two skovern.com origins by default in production", () => {
    expect(loadConfig(PROD).corsOrigins).toEqual(["https://skovern.com", "https://www.skovern.com"]);
  });

  it("keeps account routes off in production unless ACCOUNT_ROUTES=1, and on in dev", () => {
    expect(loadConfig(PROD).accountRoutes).toBe(false);
    expect(loadConfig({ ...PROD, ACCOUNT_ROUTES: "1" }).accountRoutes).toBe(true);
    expect(loadConfig({}).accountRoutes).toBe(true);
    expect(loadConfig({ ACCOUNT_ROUTES: "0" }).accountRoutes).toBe(false);
  });

  it("refuses a short admin token in production, and accepts a long one or none", () => {
    expect(() => loadConfig({ ...PROD, SKOVERN_ADMIN_TOKEN: "x".repeat(31) })).toThrow(
      "SKOVERN_ADMIN_TOKEN must be at least 32 characters in production.",
    );
    expect(loadConfig({ ...PROD, SKOVERN_ADMIN_TOKEN: "a".repeat(64) }).adminToken).toHaveLength(64);
    expect(loadConfig(PROD).adminToken).toBeNull();
    expect(loadConfig({ SKOVERN_ADMIN_TOKEN: "short" }).adminToken).toBe("short");
  });

  it("requires an https Resend URL in production", () => {
    expect(() => loadConfig({ ...PROD, RESEND_API_URL: "http://resend.test" })).toThrow(
      "RESEND_API_URL must use https:// in production.",
    );
    expect(loadConfig({ ...PROD, RESEND_API_URL: "https://resend.test/" }).resendUrl).toBe("https://resend.test");
  });

  it("never picks the link-printing dev mailers in production", () => {
    const prod = { ...loadConfig(PROD), resendKey: null };
    expect(() => pickMailers(prod)).toThrow("RESEND_API_KEY is required in production.");
    expect(pickMailers(loadConfig({})).welcome.constructor.name).toBe("DevWelcomeMailer");
    expect(pickMailers(loadConfig(PROD)).welcome.constructor.name).toBe("ResendWelcomeMailer");
  });

  it("boots in dev with no settings", () => {
    const cfg = loadConfig({});
    expect(cfg.production).toBe(false);
    expect(cfg.resendKey).toBeNull();
    expect(cfg.trustProxy).toBe(false);
  });
});

describe("RateLimiter", () => {
  it("allows max hits per window, then refuses until the window resets", () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    const limit = { max: 2, windowMs: 1000 };
    expect([rl.take("k", limit), rl.take("k", limit), rl.take("k", limit)]).toEqual([true, true, false]);
    expect(rl.take("other", limit)).toBe(true);
    t = 1000;
    expect(rl.take("k", limit)).toBe(true);
    rl.prune(5000);
    expect(rl.size).toBe(0);
  });
});

describe("clientIp", () => {
  const req = (xff: string | undefined): IncomingMessage =>
    ({ headers: { "x-forwarded-for": xff }, socket: { remoteAddress: "10.0.0.9" } }) as unknown as IncomingMessage;

  it("trusts only the rightmost X-Forwarded-For entry behind a proxy", () => {
    expect(clientIp(req("6.6.6.6, 1.2.3.4"), true)).toBe("1.2.3.4");
    expect(clientIp(req("7.7.7.7, 1.2.3.4"), true)).toBe("1.2.3.4");
  });

  it("ignores the header when no proxy is trusted", () => {
    expect(clientIp(req("1.2.3.4"), false)).toBe("10.0.0.9");
  });
});

describe("limitKey", () => {
  it("keys IPv6 on its /64, so rotating the last 64 bits doesn't help", () => {
    const k = limitKey("2001:db8:aa:bb:1:2:3:4");
    expect(k).toBe("2001:db8:aa:bb::/64");
    expect(limitKey("2001:db8:aa:bb:ffff:ffff:ffff:ffff")).toBe(k);
    expect(limitKey("2001:0db8:00aa:00bb::9")).toBe(k);
    expect(limitKey("2001:db8:aa:bc::1")).not.toBe(k);
    expect(limitKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
  });

  it("keys IPv4 and IPv4-mapped IPv6 as plain IPv4", () => {
    expect(limitKey("203.0.113.7")).toBe("203.0.113.7");
    expect(limitKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });
});

describe("limitFailures", () => {
  it("counts only failures, and then refuses even a success", async () => {
    const rl = new RateLimiter(() => 0);
    const limit = { max: 2, windowMs: 1000 };
    const ok = async () => ({ status: 200, body: {} });
    const bad = async () => ({ status: 401, body: {} });
    const failed = (r: { status: number }) => r.status === 401;
    for (let i = 0; i < 5; i += 1) expect((await limitFailures(rl, "k", limit, ok, failed)).status).toBe(200);
    expect((await limitFailures(rl, "k", limit, bad, failed)).status).toBe(401);
    expect((await limitFailures(rl, "k", limit, bad, failed)).status).toBe(401);
    expect((await limitFailures(rl, "k", limit, ok, failed)).status).toBe(429);
  });

  it("counts an attempt before it runs, so concurrent wrong guesses can't all get in", async () => {
    const rl = new RateLimiter(() => 0);
    const limit = { max: 2, windowMs: 1000 };
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const slowBad = async () => {
      await gate;
      return { status: 401, body: {} };
    };
    const failed = (r: { status: number }) => r.status === 401;
    const all = Array.from({ length: 5 }, () => limitFailures(rl, "k", limit, slowBad, failed));
    release();
    const statuses = (await Promise.all(all)).map((r) => r.status).sort();
    expect(statuses).toEqual([401, 401, 429, 429, 429]);
  });
});

describe("LruCache", () => {
  it("evicts the least recently used entry", () => {
    const c = new LruCache<number>(2);
    c.set("a", 1);
    c.set("b", 2);
    c.get("a");
    c.set("c", 3);
    expect([c.get("a"), c.get("b"), c.get("c")]).toEqual([1, undefined, 3]);
  });
});

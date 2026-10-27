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
    expect(cfg.inbox).toBeNull();
    expect(cfg.welcomeBudget).toEqual({ perHour: 20, perDay: 50 });
    expect(cfg.resendQuota).toEqual({ quota: 100, reserve: 15 });
  });

  it("reads the Resend quota and reserve, and refuses a reserve that eats the quota", () => {
    expect(loadConfig({ RESEND_DAILY_QUOTA: "3000", RESEND_RESERVE: "0" }).resendQuota).toEqual({ quota: 3000, reserve: 0 });
    expect(() => loadConfig({ RESEND_RESERVE: "100" })).toThrow("RESEND_RESERVE must be smaller than RESEND_DAILY_QUOTA.");
    expect(() => loadConfig({ RESEND_RESERVE: "-1" })).toThrow("RESEND_RESERVE must be a whole number of 0 or more.");
  });
});

describe("loadConfig inbox", () => {
  const SECRET = `whsec_${Buffer.from("0123456789abcdef0123").toString("base64")}`;
  const INBOX = { ...PROD, RESEND_WEBHOOK_SECRET: SECRET, FORWARD_TO: "jozwiakdawid+skovern@gmail.com" };

  it("stays off without RESEND_WEBHOOK_SECRET, even with FORWARD_TO", () => {
    expect(loadConfig({ ...PROD, FORWARD_TO: "a@b.test" }).inbox).toBeNull();
  });

  it("turns on with the secret and one address, at 15 forwards a day by default", () => {
    const inbox = loadConfig(INBOX).inbox;
    expect(inbox?.forwardTo).toBe("jozwiakdawid+skovern@gmail.com");
    expect(inbox?.maxPerDay).toBe(15);
    expect(inbox?.webhookKey.toString()).toBe("0123456789abcdef0123");
    expect(loadConfig({ ...INBOX, FORWARD_MAX_PER_DAY: "5" }).inbox?.maxPerDay).toBe(5);
    expect(inbox?.flaggedPerDay).toBe(2);
    expect(loadConfig({ ...INBOX, FLAGGED_MAX_PER_DAY: "0" }).inbox?.flaggedPerDay).toBe(0);
  });

  it("S2: sends from in.skovern.com by default, any skovern.com subdomain on request, skovern.com only with the fallback flag", () => {
    expect(loadConfig(INBOX).inbox).toMatchObject({ fromDomain: "in.skovern.com", fromFallback: false });
    expect(loadConfig({ ...INBOX, INBOX_FROM_DOMAIN: "Mail.Skovern.com" }).inbox?.fromDomain).toBe("mail.skovern.com");
    expect(loadConfig({ ...INBOX, INBOX_FROM_FALLBACK: "1" }).inbox).toMatchObject({
      fromDomain: "skovern.com",
      fromFallback: true,
      wantedFromDomain: "in.skovern.com",
    });
    expect(loadConfig({ ...INBOX, INBOX_FROM_FALLBACK: "0" }).inbox).toMatchObject({ fromDomain: "in.skovern.com", fromFallback: false });
    for (const bad of ["skovern.com", "evil.com", "skovern.com.evil.com", "in.notskovern.com", "a..skovern.com", "-x.skovern.com"]) {
      expect(() => loadConfig({ ...INBOX, INBOX_FROM_DOMAIN: bad }), bad).toThrow("INBOX_FROM_DOMAIN must be a subdomain of skovern.com");
    }
  });

  it.each(["true", "yes", "on", "2", "1 ", "01"])("H4: refuses INBOX_FROM_FALLBACK=%j", (v) => {
    if (v === "1 ") {
      expect(loadConfig({ ...INBOX, INBOX_FROM_FALLBACK: v }).inbox?.fromFallback).toBe(true); // trimmed
      return;
    }
    expect(() => loadConfig({ ...INBOX, INBOX_FROM_FALLBACK: v })).toThrow("INBOX_FROM_FALLBACK must be 1, 0, or unset.");
  });

  it.each([
    ["no whsec_ prefix", { RESEND_WEBHOOK_SECRET: SECRET.slice("whsec_".length) }, /RESEND_WEBHOOK_SECRET/],
    ["a short key", { RESEND_WEBHOOK_SECRET: "whsec_YWJj" }, /RESEND_WEBHOOK_SECRET/],
    ["no FORWARD_TO", { FORWARD_TO: "" }, /FORWARD_TO must be one plain email/],
    ["two addresses", { FORWARD_TO: "a@b.test,c@d.test" }, /FORWARD_TO must be one plain email/],
    ["a named address", { FORWARD_TO: "Dawid <a@b.test>" }, /FORWARD_TO must be one plain email/],
    ["our own domain", { FORWARD_TO: "hi@skovern.com" }, /can't be at skovern.com/],
    ["our own subdomain", { FORWARD_TO: "x@mail.Skovern.com" }, /can't be at skovern.com/],
    ["no Resend key", { NODE_ENV: "", RESEND_API_KEY: "" }, /RESEND_API_KEY is required when/],
    ["a zero budget", { FORWARD_MAX_PER_DAY: "0" }, /FORWARD_MAX_PER_DAY/],
  ])("refuses to boot with %s", (_label, change, message) => {
    expect(() => loadConfig({ ...INBOX, ...change })).toThrow(message);
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

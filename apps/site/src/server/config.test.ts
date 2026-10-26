import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";
import { RateLimiter } from "./rate-limit.js";
import { clientIp } from "../http.js";
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

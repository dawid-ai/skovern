// Boot configuration, validated once. In production a missing mail key, public
// URL, or database URL is a hard boot failure with a message naming the
// variable (ledger mailer-fail-closed, require-app-url-prod): a server that
// silently falls back to dev defaults on the public internet is worse than one
// that refuses to start.

// Defaults match docker-compose.yml so `pnpm dev` works right after `db:up`.
const DEV_DATABASE_URL = "postgres://skovern:skovern@localhost:5442/skovern";
const PROD_ORIGINS = ["https://skovern.com", "https://www.skovern.com"];
const DEV_ORIGINS = ["http://localhost:4321", "http://127.0.0.1:4321"];

export interface ServerConfig {
  production: boolean;
  databaseUrl: string;
  /** Public base of this API, e.g. https://api.skovern.com. Empty in dev until bound. */
  appUrl: string;
  /** Public base of the marketing site, for no-JS redirects back to it. */
  siteUrl: string;
  resendKey: string | null;
  resendUrl: string;
  mailFrom: string;
  adminToken: string | null;
  corsOrigins: string[];
  trustProxy: boolean;
  /** Sign-in, DM, publish, news, and their admin pages. Off by default in
   *  production until the beta: the public api is the waitlist and nothing else. */
  accountRoutes: boolean;
  /** Global cap on welcome emails (Resend's free tier is 100 a day). */
  welcomeBudget: { perHour: number; perDay: number };
  /** Mail to @skovern.com forwarded to one fixed inbox (loop 052). Null = the
   *  webhook route isn't mounted. */
  inbox: InboxConfig | null;
  host: string;
  port: number;
}

export interface InboxConfig {
  /** The Svix signing key: the base64 part of `whsec_...`, decoded. */
  webhookKey: Buffer;
  /** The one address every forward goes to. No request can change it. */
  forwardTo: string;
  maxPerDay: number;
}

export class ConfigError extends Error {}

/** Our own mail domain. A forward never goes to it (a loop) and mail from it is never forwarded. */
export const OWN_DOMAIN = "skovern.com";

/** True when the address is at skovern.com or one of its subdomains. */
export function isOwnDomain(address: string): boolean {
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  return domain === OWN_DOMAIN || domain.endsWith(`.${OWN_DOMAIN}`);
}

/** A single plain address: no name, no list, no spaces or line breaks. */
export const PLAIN_ADDRESS = /^[^\s@<>,;"'()]+@[^\s@<>,;"'()]+\.[^\s@<>,;"'()]+$/;

function inboxConfig(env: NodeJS.ProcessEnv, resendKey: string | null): InboxConfig | null {
  const secret = env["RESEND_WEBHOOK_SECRET"]?.trim();
  const maxPerDay = positiveInt(env, "FORWARD_MAX_PER_DAY", 25);
  if (!secret) return null;
  const match = /^whsec_([A-Za-z0-9+/]+={0,2})$/.exec(secret);
  const webhookKey = match?.[1] ? Buffer.from(match[1], "base64") : Buffer.alloc(0);
  if (webhookKey.length < 16) {
    throw new ConfigError("RESEND_WEBHOOK_SECRET must be the whsec_... signing secret from the Resend webhook.");
  }
  const forwardTo = env["FORWARD_TO"]?.trim() ?? "";
  if (!PLAIN_ADDRESS.test(forwardTo)) {
    throw new ConfigError("FORWARD_TO must be one plain email address when RESEND_WEBHOOK_SECRET is set.");
  }
  if (isOwnDomain(forwardTo)) {
    throw new ConfigError(`FORWARD_TO can't be at ${OWN_DOMAIN}: every forward would come straight back.`);
  }
  if (!resendKey) throw new ConfigError("RESEND_API_KEY is required when RESEND_WEBHOOK_SECRET is set.");
  return { webhookKey, forwardTo, maxPerDay };
}

function list(raw: string | undefined): string[] | null {
  if (!raw?.trim()) return null;
  return raw
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function positiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new ConfigError(`${key} must be a whole number of 1 or more.`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const production = env["NODE_ENV"] === "production";
  const val = (k: string): string | null => {
    const v = env[k]?.trim();
    return v ? v : null;
  };
  if (production) {
    const missing = ["RESEND_API_KEY", "APP_URL", "DATABASE_URL"].filter((k) => !val(k));
    if (missing.length) {
      throw new ConfigError(
        `Missing required setting${missing.length > 1 ? "s" : ""} in production: ${missing.join(", ")}. ` +
          `Set ${missing.length > 1 ? "them" : "it"} on the service and redeploy.`,
      );
    }
  }
  const adminToken = val("SKOVERN_ADMIN_TOKEN");
  if (production && adminToken && adminToken.length < 32) {
    throw new ConfigError("SKOVERN_ADMIN_TOKEN must be at least 32 characters in production.");
  }
  const resendUrl = (val("RESEND_API_URL") ?? "https://api.resend.com").replace(/\/$/, "");
  if (production && !resendUrl.startsWith("https://")) {
    throw new ConfigError("RESEND_API_URL must use https:// in production.");
  }
  const appUrl = (val("APP_URL") ?? "").replace(/\/$/, "");
  if (appUrl && !/^https?:\/\/[^/]+$/.test(appUrl)) {
    throw new ConfigError(`APP_URL must be a bare origin like https://api.skovern.com (got a path or bad scheme).`);
  }
  if (production && !appUrl.startsWith("https://")) {
    throw new ConfigError("APP_URL must use https:// in production.");
  }
  const resendKey = val("RESEND_API_KEY");
  return {
    production,
    databaseUrl: val("DATABASE_URL") ?? DEV_DATABASE_URL,
    appUrl,
    siteUrl: (val("SITE_URL") ?? "https://skovern.com").replace(/\/$/, ""),
    resendKey,
    resendUrl,
    mailFrom: val("MAIL_FROM") ?? "Skovern <hi@skovern.com>",
    adminToken,
    corsOrigins: list(env["CORS_ORIGINS"]) ?? (production ? PROD_ORIGINS : [...PROD_ORIGINS, ...DEV_ORIGINS]),
    trustProxy: env["TRUST_PROXY"] === "1",
    accountRoutes: env["ACCOUNT_ROUTES"] ? env["ACCOUNT_ROUTES"] === "1" : !production,
    welcomeBudget: {
      perHour: positiveInt(env, "WELCOME_MAX_PER_HOUR", 20),
      perDay: positiveInt(env, "WELCOME_MAX_PER_DAY", 70),
    },
    inbox: inboxConfig(env, resendKey),
    host: val("HOST") ?? "127.0.0.1",
    port: Number(val("PORT") ?? 8787),
  };
}

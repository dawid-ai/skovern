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
  host: string;
  port: number;
}

export class ConfigError extends Error {}

function list(raw: string | undefined): string[] | null {
  if (!raw?.trim()) return null;
  return raw
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
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
  const appUrl = (val("APP_URL") ?? "").replace(/\/$/, "");
  if (appUrl && !/^https?:\/\/[^/]+$/.test(appUrl)) {
    throw new ConfigError(`APP_URL must be a bare origin like https://api.skovern.com (got a path or bad scheme).`);
  }
  if (production && !appUrl.startsWith("https://")) {
    throw new ConfigError("APP_URL must use https:// in production.");
  }
  return {
    production,
    databaseUrl: val("DATABASE_URL") ?? DEV_DATABASE_URL,
    appUrl,
    siteUrl: (val("SITE_URL") ?? "https://skovern.com").replace(/\/$/, ""),
    resendKey: val("RESEND_API_KEY"),
    resendUrl: val("RESEND_API_URL") ?? "https://api.resend.com",
    mailFrom: val("MAIL_FROM") ?? "Skovern <hi@skovern.com>",
    adminToken: val("SKOVERN_ADMIN_TOKEN"),
    corsOrigins: list(env["CORS_ORIGINS"]) ?? (production ? PROD_ORIGINS : [...PROD_ORIGINS, ...DEV_ORIGINS]),
    trustProxy: env["TRUST_PROXY"] === "1",
    host: val("HOST") ?? "127.0.0.1",
    port: Number(val("PORT") ?? 8787),
  };
}

import pg from "pg";
import { AuthService } from "../auth/service.js";
import { AuthStore } from "../auth/store.js";
import { startAuthServer } from "../auth/server.js";
import { NewsStore } from "../news/store.js";
import { POSTS } from "../news/posts.js";
import { DmStore } from "../dm/store.js";
import { pickNotifier } from "../dm/notifier.js";
import { VisibilityStore } from "../publish/visibility-store.js";
import { WaitlistStore } from "../waitlist/store.js";
import { ConfigError, loadConfig, type ServerConfig } from "./config.js";
import { pickMailers } from "./mailers.js";
import { RateLimiter } from "./rate-limit.js";
import { startSweep, startWelcomeBacklog } from "./sweep.js";

/** SIGTERM must end the process within this, even with a stuck socket (ledger shutdown-watchdog). */
const SHUTDOWN_DEADLINE_MS = 8_000;

async function main(): Promise<void> {
  let cfg: ServerConfig;
  try {
    cfg = loadConfig(process.env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`[auth-server] can't start: ${err.message}`);
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl });
  // An idle client dropping (e.g. Postgres restart) must not crash the process.
  pool.on("error", (err) => console.error("[db] idle client error:", err.message));

  const news = new NewsStore(pool);
  const dm = new DmStore(pool);
  const visibility = new VisibilityStore(pool);
  const waitlist = new WaitlistStore(pool, cfg.welcomeBudget);
  try {
    await new AuthStore(pool).migrate();
    await news.migrate();
    await news.syncPosts(POSTS);
    await dm.migrate();
    await visibility.migrate();
    await waitlist.migrate();
  } catch (err) {
    console.error(
      `[auth-server] can't reach the database at ${cfg.databaseUrl.replace(/:[^:@/]*@/, ":***@")}.\n` +
        (cfg.production ? "" : "Run `pnpm --filter @skovern/site db:up` first. ") +
        `(${(err as Error).message})`,
    );
    await pool.end();
    process.exit(1);
  }

  const mailers = pickMailers(cfg);
  // AuthService reads config.appUrl lazily, so we can fill it from the real
  // bound URL after listening — correct even when PORT=0 picks an ephemeral port.
  const authConfig = { appUrl: cfg.appUrl };
  const auth = new AuthService(new AuthStore(pool), mailers.magic, authConfig);
  const limiter = new RateLimiter();
  const server = await startAuthServer({
    service: auth,
    news,
    dm: { auth, store: dm, notifier: pickNotifier() },
    visibility,
    adminToken: cfg.adminToken,
    publicOrigin: cfg.appUrl || undefined,
    port: cfg.port,
    host: cfg.host,
    limiter,
    trustProxy: cfg.trustProxy,
    accountRoutes: cfg.accountRoutes,
    waitlist: {
      deps: { store: waitlist, mailer: mailers.welcome, appUrl: () => authConfig.appUrl },
      limiter,
      trustProxy: cfg.trustProxy,
      corsOrigins: cfg.corsOrigins,
      adminToken: cfg.adminToken,
      siteUrl: cfg.siteUrl,
    },
  });
  if (!authConfig.appUrl) authConfig.appUrl = server.url;
  console.log(`[auth-server] listening on ${server.url}`);
  console.log(
    cfg.accountRoutes
      ? "[auth-server] account routes ON (sign-in, messages, publish, news)"
      : "[auth-server] account routes OFF: only /healthz and the waitlist are mounted (set ACCOUNT_ROUTES=1 to change)",
  );
  console.log(
    cfg.adminToken
      ? `[auth-server] admin pages: /admin/dm and /admin/waitlist — log in with ANY username and your SKOVERN_ADMIN_TOKEN as the password`
      : `[auth-server] admin pages DISABLED — set SKOVERN_ADMIN_TOKEN before starting to enable them`,
  );

  const stopSweep = startSweep(pool);
  const stopBacklog = startWelcomeBacklog({ store: waitlist, mailer: mailers.welcome, appUrl: () => authConfig.appUrl });
  const pruneTimer = setInterval(() => limiter.prune(), 5 * 60_000);
  pruneTimer.unref();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[auth-server] ${signal}: draining…`);
    stopSweep();
    stopBacklog();
    // Watchdog: a hung socket or a stuck pool must not keep the old container alive.
    setTimeout(() => {
      console.error("[auth-server] drain took too long; exiting anyway");
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS).unref();
    void server
      .close()
      .then(() => pool.end())
      .then(() => {
        console.log("[auth-server] stopped");
        process.exit(0);
      })
      .catch((err: unknown) => {
        console.error("[auth-server] shutdown error:", (err as Error).message);
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main().catch((err: unknown) => {
  console.error("[auth-server] failed to start:", err);
  process.exit(1);
});

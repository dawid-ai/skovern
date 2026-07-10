import pg from "pg";
import { DevLinkMailer, ResendMailer, type Mailer } from "../auth/mailer.js";
import { AuthService } from "../auth/service.js";
import { AuthStore } from "../auth/store.js";
import { startAuthServer } from "../auth/server.js";
import { NewsStore } from "../news/store.js";
import { POSTS } from "../news/posts.js";

// Defaults match docker-compose.yml so `pnpm dev` works right after `db:up`.
const DEFAULT_DATABASE_URL = "postgres://deskhand:deskhand@localhost:5442/deskhand";

function pickMailer(): Mailer {
  const key = process.env["RESEND_API_KEY"];
  if (key) return new ResendMailer(key, process.env["MAIL_FROM"] ?? "Deskhand <hi@deskhand.app>");
  if (process.env["NODE_ENV"] === "production") {
    // DevLinkMailer prints full single-use tokens — never in prod.
    throw new Error("RESEND_API_KEY is required in production");
  }
  return new DevLinkMailer();
}

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
  const port = Number(process.env["PORT"] ?? 8787);
  const pool = new pg.Pool({ connectionString: databaseUrl });

  const news = new NewsStore(pool);
  try {
    await new AuthStore(pool).migrate();
    await news.migrate();
    await news.syncPosts(POSTS);
  } catch (err) {
    console.error(
      `[auth-server] can't reach the database at ${databaseUrl.replace(/:[^:@/]*@/, ":***@")}.\n` +
        `Run \`pnpm --filter @deskhand/site db:up\` first. (${(err as Error).message})`,
    );
    await pool.end();
    process.exit(1);
  }

  // AuthService reads config.appUrl lazily, so we can fill it from the real
  // bound URL after listening — correct even when PORT=0 picks an ephemeral port.
  const config = { appUrl: process.env["APP_URL"] ?? "" };
  const server = await startAuthServer({
    service: new AuthService(new AuthStore(pool), pickMailer(), config),
    news,
    port,
  });
  if (!config.appUrl) config.appUrl = server.url;
  console.log(`[auth-server] listening on ${server.url}`);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[auth-server] shutting down…");
    void server
      .close()
      .then(() => pool.end())
      .then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((err: unknown) => {
  console.error("[auth-server] failed to start:", err);
  process.exit(1);
});

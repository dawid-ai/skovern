import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import {
  AuthService,
  AuthStore,
  ConsoleMailer,
  ConsoleNotifier,
  DmStore,
  NewsStore,
  POSTS,
  startAuthServer,
  type RunningServer,
} from "@deskhand/site";

// Loop 008 metric: the news + DM features, end to end, THROUGH THE REAL APP —
// Electron UI → preload → IPC → core client → real server (news + dm wired) →
// real Postgres. Proves a signed-in user can see the news and message the
// founder by hand, and that the message actually lands in the database.

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let server: RunningServer;
let mailer: ConsoleMailer;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  await new AuthStore(pool).migrate();
  const news = new NewsStore(pool);
  await news.migrate();
  await news.syncPosts(POSTS); // seed the real ship notes
  const dm = new DmStore(pool);
  await dm.migrate();
  mailer = new ConsoleMailer();
  const auth = new AuthService(new AuthStore(pool), mailer, { appUrl: "https://app.test" });
  server = await startAuthServer({
    service: auth,
    news,
    dm: { auth, store: dm, notifier: new ConsoleNotifier() },
  });
});

test.afterAll(async () => {
  await server?.close();
  await pool?.end();
  await container?.stop();
});

test("signed-in user sees the news and can message the founder", async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "deskhand-e2e-"));
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: { ...process.env, DESKHAND_API_URL: server.url },
  });

  try {
    const page = await app.firstWindow();

    // sign in through the real UI
    await page.getByLabel("Your email").fill("owner@flowershop.test");
    await page.getByRole("button", { name: "Send me a link" }).click();
    await expect.poll(() => mailer.sent.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.getByLabel("Paste your link").fill(mailer.sent[mailer.sent.length - 1]!.url);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText(/founding user #1/i)).toBeVisible();

    // 1. default page is "What's new": the seeded feed shows, the composer does NOT
    await expect(page.getByRole("heading", { name: POSTS[0]!.title })).toBeVisible();
    await expect(page.getByLabel("Your message")).toHaveCount(0);

    // 2. navigate to Messages: composer shows, the news feed does NOT (separate pages)
    await page.getByRole("button", { name: "Messages" }).click();
    await expect(page.getByLabel("Your message")).toBeVisible();
    await expect(page.getByRole("heading", { name: POSTS[0]!.title })).toHaveCount(0);

    // 3. send a message to the founder
    const message = "Hi Dawid — the florist test says this app is friendly!";
    await page.getByLabel("Your message").fill(message);
    await page.getByRole("button", { name: "Send" }).click();

    // 4. on-screen confirmation
    await expect(page.getByText(/Dawid will see this/i)).toBeVisible();

    // 5. it actually landed server-side (UI is wired to the real backend)
    await expect
      .poll(
        async () => {
          const { rows } = await pool.query<{ body: string }>(
            "SELECT body FROM dm_messages WHERE body = $1",
            [message],
          );
          return rows.length;
        },
        { timeout: 15_000 },
      )
      .toBe(1);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

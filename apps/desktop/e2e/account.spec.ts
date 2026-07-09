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
  startAuthServer,
  type RunningServer,
} from "@deskhand/site";

// Contract 003 metric: the whole account vertical, end to end, no mocks —
// real Electron window → preload → IPC → core client → real http server →
// real Postgres → back to the window, and the session survives a restart.

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let server: RunningServer;
let mailer: ConsoleMailer;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  await new AuthStore(pool).migrate();
  mailer = new ConsoleMailer();
  const service = new AuthService(new AuthStore(pool), mailer, { appUrl: "https://app.test" });
  server = await startAuthServer({ service });
});

test.afterAll(async () => {
  await server?.close();
  await pool?.end();
  await container?.stop();
});

test("sign in end to end and stay signed in across a restart", async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "deskhand-e2e-"));
  const launchOpts = {
    args: [".", `--user-data-dir=${userDataDir}`],
    env: { ...process.env, DESKHAND_API_URL: server.url },
  };

  try {
    // --- first launch: sign in through the real UI ---
    const app = await electron.launch(launchOpts);
    const page = await app.firstWindow();

    await page.getByLabel("Your email").fill("owner@flowershop.test");
    await page.getByRole("button", { name: "Send me a link" }).click();

    // the link the server actually issued (captured in-process by the mailer)
    await expect.poll(() => mailer.sent.length, { timeout: 30_000 }).toBeGreaterThan(0);
    const magicLink = mailer.sent[mailer.sent.length - 1]!.url;

    await page.getByLabel("Paste your link").fill(magicLink);
    await page.getByRole("button", { name: "Verify" }).click();

    await expect(page.getByRole("heading", { name: /founding user #1/i })).toBeVisible();
    await app.close();

    // --- relaunch: session persisted, no re-prompt ---
    const app2 = await electron.launch(launchOpts);
    const page2 = await app2.firstWindow();
    await expect(page2.getByRole("heading", { name: /founding user #1/i })).toBeVisible();
    await expect(page2.getByLabel("Your email")).toHaveCount(0);

    // --- sign out clears the persisted session ---
    await page2.getByRole("button", { name: "Sign out" }).click();
    await expect(page2.getByLabel("Your email")).toBeVisible();
    await app2.close();

    // --- relaunch after sign-out: prompted again, not signed in ---
    const app3 = await electron.launch(launchOpts);
    const page3 = await app3.firstWindow();
    await expect(page3.getByLabel("Your email")).toBeVisible();
    await expect(page3.getByRole("heading", { name: /founding user #1/i })).toHaveCount(0);
    await app3.close();
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

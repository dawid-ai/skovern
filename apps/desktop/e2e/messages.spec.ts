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
  startAuthServer,
  type RunningServer,
} from "@deskhand/site";

// Loop 010 metric: two-way founder chat THROUGH THE REAL APP — user sends,
// founder replies (via the admin endpoint), the reply lands in the user's
// thread, the Messages nav shows an unread badge while off-page, and the badge
// clears when the user opens Messages.

const ADMIN_PW = "messages-loop-test-pw";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let server: RunningServer;
let mailer: ConsoleMailer;

function basic(password: string): string {
  return "Basic " + Buffer.from(`admin:${password}`).toString("base64");
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  await new AuthStore(pool).migrate();
  const news = new NewsStore(pool);
  await news.migrate();
  const dm = new DmStore(pool);
  await dm.migrate();
  mailer = new ConsoleMailer();
  const auth = new AuthService(new AuthStore(pool), mailer, { appUrl: "https://app.test" });
  server = await startAuthServer({
    service: auth,
    news,
    dm: { auth, store: dm, notifier: new ConsoleNotifier() },
    adminToken: ADMIN_PW,
  });
});

test.afterAll(async () => {
  await server?.close();
  await pool?.end();
  await container?.stop();
});

test("user and founder hold a two-way conversation with an unread badge", async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "deskhand-e2e-"));
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: { ...process.env, DESKHAND_API_URL: server.url },
  });

  try {
    const page = await app.firstWindow();
    const email = "chat@shop.test";

    // sign in
    await page.getByLabel("Your email").fill(email);
    await page.getByRole("button", { name: "Send me a link" }).click();
    await expect.poll(() => mailer.sent.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.getByLabel("Paste your link").fill(mailer.sent[mailer.sent.length - 1]!.url);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText(/founding user #1/i)).toBeVisible();

    // on the default (What's new) page there is no unread badge yet
    await expect(page.getByLabel(/unread/)).toHaveCount(0);

    // the founder replies out-of-band via the admin endpoint
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM accounts WHERE email = $1", [email]);
    const accountId = rows[0]!.id;
    const reply = "Welcome aboard — happy to help anytime!";
    const res = await fetch(`${server.url}/admin/dm/reply`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: basic(ADMIN_PW) },
      body: new URLSearchParams({ accountId, body: reply }).toString(),
      redirect: "manual",
    });
    expect([302, 303]).toContain(res.status);

    // the Shell polls → the unread badge appears while still on "What's new"
    await expect(page.getByLabel(/unread/)).toBeVisible({ timeout: 20_000 });

    // open Messages: the founder's reply is in the thread, and the badge clears
    await page.getByRole("button", { name: "Messages" }).click();
    await expect(page.getByText(reply)).toBeVisible();
    await expect(page.getByText("Dawid", { exact: true })).toBeVisible(); // the founder bubble label
    await expect(page.getByLabel(/unread/)).toHaveCount(0);

    // the user replies from the app — it appears in the thread + lands server-side
    const mine = "Thanks Dawid, will do!";
    await page.getByLabel("Your message").fill(mine);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText(mine)).toBeVisible();
    await expect
      .poll(
        async () => {
          const q = await pool.query(
            "SELECT 1 FROM dm_messages WHERE body = $1 AND sender = 'user'",
            [mine],
          );
          return q.rowCount;
        },
        { timeout: 15_000 },
      )
      .toBe(1);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

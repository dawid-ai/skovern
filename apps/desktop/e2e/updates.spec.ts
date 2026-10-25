import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { AuthService, AuthStore, ConsoleMailer, startAuthServer, type RunningServer } from "@skovern/site";

// release-updates metric, app level (real Electron UI, real server, fake update feed through
// the unpackaged-only SKOVERN_UPDATER_FAKE seam — GitHub is never contacted):
//   M1 the sign-in footer and Settings → Updates show the same version (app.getVersion()).
//   M2 available → notice on every page → Update now → progress → Restart now installs; Later hides.
//   M3 degraded: failed background check stays quiet, failed user check says so, failed
//      download offers Try again, no double check while checking, dev build can't check.
//   M4 the check is a grouped routine receipt; the download is its own line; both on disk.
//   M5 at 800×520 the notice stays in the window, clear of the nav and the chat Send button.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_VERSION = (JSON.parse(readFileSync(path.resolve(__dirname, "../package.json"), "utf8")) as { version: string }).version;
const OFFER = "A new Skovern is here (0.99.0).";
const NOTICE = 'aside[aria-label="Skovern update"]';

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
  const auth = new AuthService(new AuthStore(pool), mailer, { appUrl: "https://app.test" });
  server = await startAuthServer({ service: auth });
});

test.afterAll(async () => {
  await server?.close();
  await pool?.end();
  await container?.stop();
});

async function launch(fake: string | null, opts: { auto?: boolean } = {}): Promise<{ app: ElectronApplication; page: Page; userDataDir: string }> {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  if (opts.auto === false) writeFileSync(path.join(userDataDir, "settings.json"), JSON.stringify({ autoUpdates: false }));
  const env: Record<string, string> = { ...(process.env as Record<string, string>), SKOVERN_API_URL: server.url };
  delete env["SKOVERN_UPDATER_FAKE"];
  if (fake) env["SKOVERN_UPDATER_FAKE"] = fake;
  const app = await electron.launch({ args: [".", `--user-data-dir=${userDataDir}`], env });
  return { app, page: await app.firstWindow(), userDataDir };
}

let accounts = 0;
async function signIn(page: Page): Promise<void> {
  accounts += 1;
  await page.getByLabel("Your email").fill(`updates${accounts}@shop.test`);
  await page.getByRole("button", { name: "Send me a link" }).click();
  await expect.poll(() => mailer.sent.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(accounts);
  await page.getByLabel("Paste your link").fill(mailer.sent[mailer.sent.length - 1]!.url);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText(/founding user #/i)).toBeVisible();
}

async function close(app: ElectronApplication, userDataDir: string): Promise<void> {
  await app.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

const installs = (app: ElectronApplication): Promise<number | undefined> =>
  app.evaluate(() => (globalThis as { __skovernFakeInstalls?: { count: number } }).__skovernFakeInstalls?.count);

test("M1/M2/M4: offer → every page → Update now → Restart now; one version everywhere; receipted", async () => {
  test.setTimeout(120_000);
  const { app, page, userDataDir } = await launch("available");
  try {
    // M1: the sign-in footer shows the app's own version…
    await expect(page.getByText(`Skovern v${APP_VERSION} — running locally`)).toBeVisible();
    // …and the startup check already offers the update, even before signing in.
    await expect(page.locator(NOTICE).getByText(OFFER)).toBeVisible();
    await signIn(page);

    // M2: the notice is on every page, with the release notes as plain text.
    const notice = page.locator(NOTICE);
    await expect(notice.getByText(OFFER)).toBeVisible();
    await expect(notice.getByText("Your brain answers faster.")).toBeVisible();
    await page.getByRole("button", { name: "Receipts" }).click();
    await expect(notice.getByText(OFFER)).toBeVisible();

    // Later hides it; Settings → Updates still has it, with the same version as the footer.
    await notice.getByRole("button", { name: "Later" }).click();
    await expect(notice).toHaveCount(0);
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByText(`You have Skovern ${APP_VERSION}.`)).toBeVisible();
    await expect(page.getByText("Version 0.99.0 is ready to get.")).toBeVisible();

    // Update now → progress → ready. Nothing downloaded until this click.
    expect(readFileSync(path.join(userDataDir, "receipts.jsonl"), "utf8")).not.toContain("update download");
    await page.getByRole("button", { name: "Update now" }).click();
    await expect(page.getByText(/Getting the update… \d+%/).first()).toBeVisible();
    await expect(notice.getByText("The update is ready. Restart Skovern to finish.")).toBeVisible();
    await expect(page.getByText("Version 0.99.0 is downloaded. Restart Skovern to finish.")).toBeVisible();
    expect(await installs(app)).toBe(0);
    await notice.getByRole("button", { name: "Restart now" }).click();
    await expect.poll(() => installs(app)).toBe(1);

    // M4: the check groups as a routine line; the download is its own row; both on disk.
    await page.getByRole("button", { name: "Receipts" }).click();
    await expect(page.getByText("Checked for a Skovern update")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("tr.receipt-row", { hasText: "update download" }).first()).toBeVisible();
    const log = readFileSync(path.join(userDataDir, "receipts.jsonl"), "utf8");
    expect(log).toMatch(/"host":"github.com","task":"Skovern: update check"[^}]*"routine":true/);
    expect(log).toMatch(/"task":"Skovern: update download"[^}]*"phase":"done"/);
  } finally {
    await close(app, userDataDir);
  }
});

test("M3: up to date, and no second check while one is running", async () => {
  test.setTimeout(90_000);
  const { app, page, userDataDir } = await launch("slow", { auto: false });
  try {
    await signIn(page);
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByText("Automatic checks are off.")).toBeVisible();
    const check = page.getByRole("button", { name: "Check for updates" });
    await check.click();
    await expect(page.getByText("Checking for a new version…")).toBeVisible();
    await expect(check).toBeDisabled();
    await expect(page.getByText("You're up to date.")).toBeVisible({ timeout: 10_000 });
    await expect(check).toBeEnabled();
    await expect(page.locator(NOTICE)).toHaveCount(0);
    // one check only, despite the disabled button
    const checks = readFileSync(path.join(userDataDir, "receipts.jsonl"), "utf8").split("\n").filter((l) => l.includes('"task":"Skovern: update check"') && l.includes('"phase":"sent"'));
    expect(checks).toHaveLength(1);
  } finally {
    await close(app, userDataDir);
  }
});

test("M3: a failed background check stays quiet; a failed check you started says so", async () => {
  test.setTimeout(90_000);
  const { app, page, userDataDir } = await launch("error");
  try {
    await signIn(page);
    await page.getByRole("button", { name: "Settings" }).click();
    // the startup check failed, quietly
    await expect(page.getByText("Skovern looks for new versions by itself.")).toBeVisible();
    await expect(page.getByText(/Couldn't check/)).toHaveCount(0);
    await expect(page.locator(NOTICE)).toHaveCount(0);
    await page.getByRole("button", { name: "Check for updates" }).click();
    await expect(page.getByText("Couldn't check just now. Check your internet connection and try again.")).toBeVisible();
    await expect(page.locator(NOTICE)).toHaveCount(0);
  } finally {
    await close(app, userDataDir);
  }
});

test("M3: a failed download offers Try again", async () => {
  test.setTimeout(90_000);
  const { app, page, userDataDir } = await launch("download-error");
  try {
    const notice = page.locator(NOTICE);
    await notice.getByRole("button", { name: "Update now" }).click();
    await expect(notice.getByText("The update didn't finish.")).toBeVisible();
    await expect(notice.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(await installs(app)).toBe(0);
  } finally {
    await close(app, userDataDir);
  }
});

test("M3: a dev build with no feed can't check, and says why", async () => {
  test.setTimeout(90_000);
  const { app, page, userDataDir } = await launch(null);
  try {
    await signIn(page);
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByText("Updates work in the installed app.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Check for updates" })).toBeDisabled();
    await expect(page.getByLabel("Check for updates automatically")).toHaveCount(0);
  } finally {
    await close(app, userDataDir);
  }
});

test("M5: at 800×520 the notice stays in the window, clear of the nav and the chat Send button", async () => {
  test.setTimeout(90_000);
  const { app, page, userDataDir } = await launch("available");
  try {
    await signIn(page);
    // a cloud brain with a placeholder key, so Chat shows its composer (no call is made)
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Your key").fill("sk-placeholder-never-used");
    await page.getByRole("button", { name: "Save brain" }).click();
    await expect(page.getByText("Brain saved.")).toBeVisible();
    await page.getByRole("button", { name: "Chat" }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(800, 520));
    await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([800, 520]);

    const notice = page.locator(NOTICE);
    await expect(notice.getByText(OFFER)).toBeVisible();
    const box = (await notice.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(800);
    expect(box.y + box.height).toBeLessThanOrEqual(520);
    const nav = (await page.locator("nav.sidebar").boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(nav.x + nav.width);
    const send = (await page.getByRole("button", { name: "Send", exact: true }).boundingBox())!;
    const overlaps = box.x < send.x + send.width && send.x < box.x + box.width && box.y < send.y + send.height && send.y < box.y + box.height;
    expect(overlaps).toBe(false);
    // the notice's own buttons are reachable at this size
    await expect(notice.getByRole("button", { name: "Update now" })).toBeInViewport();
  } finally {
    await close(app, userDataDir);
  }
});

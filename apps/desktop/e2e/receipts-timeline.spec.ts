import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { AuthService, AuthStore, ConsoleMailer, startAuthServer, type RunningServer } from "@deskhand/site";

// Loop 027 metric (app-level, real Electron UI + real main + real log): seed the egress
// log with receipts at KNOWN past dates, pin "today" via DESKHAND_NOW, then drive the
// Receipts page — the activity calendar shows history (busier day darker), the date
// range narrows the table, pagination navigates, and "Export selected → CSV" writes a
// spreadsheet of the picked rows. Sign-in/background polls land on the REAL current day
// (outside the seeded range), so every table assertion filters to the seeded window and
// stays deterministic on any runner.

const NOW = "2026-07-14T00:00:00.000Z"; // pins the calendar grid's end day
const BUSY_DAY = "2026-07-02"; // 20 receipts — the busiest square
const LIGHT_DAY = "2026-07-05"; // 1 receipt — a faint square
const EMPTY_DAY = "2026-07-04"; // 0 receipts — an empty square
const OLD_DAY = "2026-06-25"; // 6 receipts — older, lands on page 2
const RANGE_FROM = "2026-06-20";
const RANGE_TO = "2026-07-10"; // spans all seeded days, excludes the real-now sign-in
// A receipt seeded in the OLDEST archive file — beyond the recent (last-2-files) window,
// so it's reachable ONLY via the full-history ranged read. Proves finding #1's fix e2e.
const ARCHIVED_DAY = "2026-05-10";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let server: RunningServer;
let mailer: ConsoleMailer;

// Build model receipts (done) on a given UTC day, oldest→newest so the file is
// chronological (readReceipts reverses to newest-first).
function seedLines(): string {
  const rows: string[] = [];
  const add = (day: string, n: number, tag: string): void => {
    for (let i = 0; i < n; i++) {
      rows.push(
        JSON.stringify({
          ts: `${day}T${String(8 + (i % 12)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z`,
          provider: "openrouter",
          model: "m",
          task: `${tag}-${i}`,
          bytesSent: 10 + i,
          bytesReceived: 20 + i,
          ok: true,
          phase: "done",
        }),
      );
    }
  };
  add(OLD_DAY, 6, "old"); // oldest
  add(BUSY_DAY, 20, "busy");
  add(LIGHT_DAY, 1, "light"); // newest of the seeded set
  return rows.join("\n") + "\n";
}

// The cal-level digit (0–4) baked into a day square's class, for relative-darkness checks.
async function calLevel(page: Page, day: string): Promise<number> {
  const cls = (await page.locator(`[title^="${day}:"]`).first().getAttribute("class")) ?? "";
  const m = /cal-(\d)/.exec(cls);
  return m ? Number(m[1]) : -1;
}

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

async function signIn(page: Page): Promise<void> {
  await page.getByLabel("Your email").fill("timeline@shop.test");
  await page.getByRole("button", { name: "Send me a link" }).click();
  await expect.poll(() => mailer.sent.length, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.getByLabel("Paste your link").fill(mailer.sent[mailer.sent.length - 1]!.url);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText(/founding user #1/i)).toBeVisible();
}

test("the Receipts timeline: calendar, date filter, pagination, and CSV export", async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "deskhand-e2e-timeline-"));
  const exportPath = path.join(userDataDir, "export.csv");
  // Seed the log BEFORE launch so the page reads it on open. Two dated ARCHIVE files +
  // the live file: the oldest archive is beyond the recent (last-2-files) window, so its
  // row is reachable only through the full-history ranged read.
  const archivedRow = JSON.stringify({
    ts: `${ARCHIVED_DAY}T09:00:00.000Z`,
    provider: "openrouter",
    model: "m",
    task: "archived-old",
    bytesSent: 1,
    bytesReceived: 2,
    ok: true,
    phase: "done",
  });
  const midRow = JSON.stringify({
    ts: "2026-06-01T09:00:00.000Z", // before RANGE_FROM, so it stays out of the pagination range
    provider: "openrouter",
    model: "m",
    task: "archived-mid",
    bytesSent: 1,
    bytesReceived: 2,
    ok: true,
    phase: "done",
  });
  writeFileSync(path.join(userDataDir, "receipts.20260510T000000Z.jsonl"), archivedRow + "\n"); // oldest archive
  writeFileSync(path.join(userDataDir, "receipts.20260601T000000Z.jsonl"), midRow + "\n"); // middle archive (in recent window)
  writeFileSync(path.join(userDataDir, "receipts.jsonl"), seedLines());

  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      DESKHAND_API_URL: server.url,
      DESKHAND_NOW: NOW,
      DESKHAND_EXPORT_PATH: exportPath,
    },
  });

  try {
    const page = await app.firstWindow();
    await signIn(page);
    await page.getByRole("button", { name: "Receipts" }).click();
    await expect(page.getByRole("heading", { name: "What leaves your machine" })).toBeVisible();

    // 1 — Calendar renders history: the busy day is darker than the light day, and the
    // empty day is empty. (Relative levels, robust to the exact busiest count.)
    await expect(page.getByRole("heading", { name: "Your activity" })).toBeVisible();
    const busy = await calLevel(page, BUSY_DAY);
    const light = await calLevel(page, LIGHT_DAY);
    const empty = await calLevel(page, EMPTY_DAY);
    expect(busy).toBeGreaterThan(light);
    expect(light).toBeGreaterThan(0);
    expect(empty).toBe(0);
    // Hovering surfaces the count (in the square's title).
    await expect(page.locator(`[title="${BUSY_DAY}: 20 things"]`).first()).toBeVisible();

    // 2 — Date range narrows the table. Filter to the seeded window (excludes the
    // real-now sign-in row): 27 meaningful rows → 2 pages of 20.
    await page.getByLabel("From").fill(RANGE_FROM);
    await page.getByLabel("To").fill(RANGE_TO);
    await expect(page.getByText("Page 1 of 2")).toBeVisible();
    const firstPageRows = page.locator(".receipt-table tbody tr");
    await expect(firstPageRows).toHaveCount(20);
    // Page 1 is newest → the light day (2026-07-05) shows; the old day does not yet.
    await expect(page.locator(".receipt-why", { hasText: "light-0" })).toBeVisible();
    await expect(page.locator(".receipt-why", { hasText: "old-0" })).toHaveCount(0);

    // 3 — Pagination: page 2 shows different (older) rows.
    await page.getByRole("button", { name: /Older/ }).click();
    await expect(page.getByText("Page 2 of 2")).toBeVisible();
    await expect(page.locator(".receipt-why", { hasText: "old-0" })).toBeVisible();
    await expect(page.locator(".receipt-why", { hasText: "light-0" })).toHaveCount(0);

    // 3b — Full-history reach: a range over the OLDEST archive (beyond the recent window)
    // surfaces its row in the real table — the calendar's history is actually reachable.
    await page.getByLabel("From").fill("2026-05-01");
    await page.getByLabel("To").fill("2026-05-31");
    await expect(page.locator(".receipt-why", { hasText: "archived-old" })).toBeVisible();

    // 2b — A range with no receipts shows the empty state, and the calendar still renders.
    await page.getByLabel("From").fill("2026-01-01");
    await page.getByLabel("To").fill("2026-01-02");
    await expect(page.getByText(/No activity in those dates/i)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your activity" })).toBeVisible();

    // 4 — Export selected → CSV. Nothing selected first: Export is disabled. Clicking the
    // light day filters to its 1 row; select all shown; export writes the file.
    await page.getByRole("button", { name: "Clear dates" }).click();
    await expect(page.getByRole("button", { name: /Export/ })).toBeDisabled();
    await page.locator(`[title="${LIGHT_DAY}: 1 thing"]`).first().click();
    await expect(page.getByLabel("From")).toHaveValue(LIGHT_DAY); // clicking a day set the range
    await expect(page.locator(".receipt-why", { hasText: "light-0" })).toBeVisible(); // ranged reload done
    await expect(page.locator(".receipt-table tbody tr")).toHaveCount(1);
    await page.getByLabel("Select all shown").check();
    await page.getByRole("button", { name: /Export/ }).click();
    await expect.poll(() => existsSync(exportPath), { timeout: 15_000 }).toBe(true);

    const csv = readFileSync(exportPath, "utf8");
    const [header, ...rows] = csv.trimEnd().split("\r\n");
    expect(header).toBe("ts,kind,provider,model,host,task,direction,routine,local,bytesSent,bytesReceived,tokensIn,tokensOut,ok,phase");
    expect(rows).toHaveLength(1); // exactly the one selected (light) row
    expect(rows[0]).toContain("light-0");
    expect(rows[0]).toContain(",openrouter,m,"); // full fields, not just what the panel shows
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

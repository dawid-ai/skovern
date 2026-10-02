import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { AuthService, AuthStore, ConsoleMailer, startAuthServer, type RunningServer } from "@skovern/site";

// Loop 014 metric (app-level, THROUGH THE REAL provider path): sign in → Settings →
// pick "Claude Code (my subscription)" (NO key field) → Save → Test my brain answers
// via a stub `claude` → then run the real AI Visibility skill ON the subscription brain
// and see a score. The stub is a node script the provider spawns shell-free via the
// dev-only SKOVERN_CLAUDE_BIN/ARGS seam — so CI needs no real subscription.

// One canned answer for every `claude -p` call: names the business (→ score) and
// carries a competitor JSON block. Doubles as the "Test my brain" reply. Passed to
// the stub via env so we avoid brittle escaping into the stub source.
const REPLY =
  'Yes! Rose & Thorn is a lovely florist in Leeds. Top options:\n```json\n["Petal Pushers", "Bloom Room"]\n```';
const STUB = `
let d = "";
process.stdin.on("data", (c) => (d += c));
process.stdin.on("end", () => { process.stdout.write(process.env.STUB_REPLY || ""); process.exit(0); });
`;

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let server: RunningServer;
let mailer: ConsoleMailer;
let stubDir: string;
let stubPath: string;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  await new AuthStore(pool).migrate();
  mailer = new ConsoleMailer();
  const auth = new AuthService(new AuthStore(pool), mailer, { appUrl: "https://app.test" });
  server = await startAuthServer({ service: auth });
  stubDir = mkdtempSync(path.join(tmpdir(), "claude-stub-"));
  stubPath = path.join(stubDir, "stub.mjs");
  writeFileSync(stubPath, STUB);
});

test.afterAll(async () => {
  await server?.close();
  await pool?.end();
  await container?.stop();
  rmSync(stubDir, { recursive: true, force: true });
});

test("user picks the Claude Code subscription brain (no key) and runs a skill on it", async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      SKOVERN_API_URL: server.url,
      // spawn `node <stub> -p` in place of the real `claude` (dev/test seam)
      SKOVERN_CLAUDE_BIN: process.execPath,
      SKOVERN_CLAUDE_ARGS: JSON.stringify([stubPath]),
      STUB_REPLY: REPLY,
    },
  });

  try {
    const page = await app.firstWindow();

    // sign in
    await page.getByLabel("Your email").fill("subs@shop.test");
    await page.getByRole("button", { name: "Send me a link" }).click();
    await expect.poll(() => mailer.sent.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.getByLabel("Paste your link").fill(mailer.sent[mailer.sent.length - 1]!.url);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText(/founding user #1/i)).toBeVisible();

    // Settings → pick the subscription brain; there is NO key field to fill
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Pick a brain").selectOption({ label: "Claude Code (my subscription)" });
    await expect(page.getByLabel("Your key")).toHaveCount(0);
    await page.getByRole("button", { name: "Save brain" }).click();
    await expect(page.getByText("Brain saved.")).toBeVisible();

    // Test my brain — the stub answers, and a receipt line is shown
    await page.getByRole("button", { name: "Test my brain" }).click();
    await expect(page.getByText(/Rose & Thorn is a lovely florist/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Sent .* to Claude Code/)).toBeVisible();

    // Run a REAL skill on the subscription brain → a score renders (the whole point)
    await page.getByRole("button", { name: "Skills" }).click();
    await page.getByRole("button", { name: "Open" }).click();
    await page.getByLabel("Your business name").fill("Rose & Thorn");
    await page.getByLabel("What kind of business?").fill("florist");
    await page.getByLabel("Your town or city").fill("Leeds");
    await page.getByRole("button", { name: "Check my visibility" }).click();
    await expect(page.getByText(/AI knows you well/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Petal Pushers", { exact: true })).toBeVisible();

    // receipts on disk are tagged claude-cli — and there is no key anywhere
    const log = readFileSync(path.join(userDataDir, "receipts.jsonl"), "utf8");
    expect(log).toContain('"provider":"claude-cli"');
    expect(log).toContain('"task":"Test my brain"');
    expect(log).toContain('"task":"skill:ai-visibility"');
    expect(log).not.toContain("apiKey");
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

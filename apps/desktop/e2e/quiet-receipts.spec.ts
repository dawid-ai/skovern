import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

// Loop 023 metric (app-level, real Electron UI): the Receipts page as a two-way ledger.
// Against a real auth+dm+news server + a mock brain, drive the whole flow and prove:
// - In/Out flow tags render from the authoritative field (cloud brain = Out, news = In,
//   your message = Out, a founder reply = In);
// - a genuinely NEW founder reply is ONE distinct "In" entry, and re-polling the same
//   thread never adds another (old/read never re-counted);
// - the routine background checks stay grouped in the panel AND are still on disk (the
//   "every byte that leaves is logged" invariant is untouched);
// - a sent message is receipted as metadata only — the message text never hits the log.

const ADMIN_PW = "quiet-receipts-test-pw";
const BRAIN_REPLY = "Hello! I'm your brain and I'm working.";
const FAKE_KEY = "sk-fake-test-key-never-logged";
const MY_MESSAGE = "secret-florist-message-please-do-not-log";
const FOUNDER_REPLY = "Welcome aboard — happy to help!";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let server: RunningServer;
let mailer: ConsoleMailer;
let brain: Server;
let brainUrl: string;

function basic(password: string): string {
  return "Basic " + Buffer.from(`admin:${password}`).toString("base64");
}

// A tiny OpenAI-compatible endpoint so "Test my brain" does a real cloud round-trip.
function startMockBrain(): Promise<string> {
  return new Promise((resolve) => {
    brain = createServer((req, res) => {
      if (req.method === "POST" && (req.url ?? "").endsWith("/chat/completions")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-mock",
            object: "chat.completion",
            created: 0,
            model: "mock-model",
            choices: [{ index: 0, message: { role: "assistant", content: BRAIN_REPLY }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    brain.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(brain.address() as AddressInfo).port}`));
  });
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
  brainUrl = await startMockBrain();
});

test.afterAll(async () => {
  await server?.close();
  await pool?.end();
  await container?.stop();
  brain?.close();
});

test("Receipts reads as a two-way ledger: In/Out tags, one entry per new reply, routine stays quiet", async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "deskhand-e2e-"));
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: { ...process.env, DESKHAND_API_URL: server.url, DESKHAND_OPENROUTER_BASE_URL: brainUrl },
  });

  try {
    const page = await app.firstWindow();
    const email = "ledger@shop.test";

    // sign in
    await page.getByLabel("Your email").fill(email);
    await page.getByRole("button", { name: "Send me a link" }).click();
    await expect.poll(() => mailer.sent.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.getByLabel("Paste your link").fill(mailer.sent[mailer.sent.length - 1]!.url);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText(/founding user #1/i)).toBeVisible();

    // a cloud brain call (Test my brain) → an OUT receipt (your prompt leaves)
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Your key").fill(FAKE_KEY);
    await page.getByRole("button", { name: "Save brain" }).click();
    await expect(page.getByText("Brain saved.")).toBeVisible();
    await page.getByRole("button", { name: "Test my brain" }).click();
    await expect(page.getByText(BRAIN_REPLY)).toBeVisible({ timeout: 20_000 });

    // the founder replies out-of-band → the Shell's 5s poll detects it → a distinct In entry
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM accounts WHERE email = $1", [email]);
    const accountId = rows[0]!.id;
    const res = await fetch(`${server.url}/admin/dm/reply`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: basic(ADMIN_PW) },
      body: new URLSearchParams({ accountId, body: FOUNDER_REPLY }).toString(),
      redirect: "manual",
    });
    expect([302, 303]).toContain(res.status);
    // badge appears once the poll picks up the reply (proves the poll ran + entry written)
    await expect(page.getByLabel(/unread/)).toBeVisible({ timeout: 20_000 });

    // send a message from the app → an OUT receipt; the TEXT must never reach the log
    await page.getByRole("button", { name: "Messages" }).click();
    await expect(page.getByText(FOUNDER_REPLY)).toBeVisible();
    await page.getByLabel("Your message").fill(MY_MESSAGE);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText(MY_MESSAGE)).toBeVisible();

    // ---- Receipts page: the two-way ledger ----
    await page.getByRole("button", { name: "Receipts" }).click();

    // (1) In/Out tags render from the authoritative field
    const brainRow = page.locator("tr.receipt-row", { hasText: "Test my brain" });
    await expect(brainRow.getByText("Out ↑")).toBeVisible({ timeout: 20_000 });
    const sendRow = page.locator("tr.receipt-row", { hasText: "your message to Dawid" });
    await expect(sendRow.getByText("Out ↑")).toBeVisible();
    const replyRow = page.locator("tr.receipt-row", { hasText: "new reply from Dawid" });
    await expect(replyRow.getByText("In ↓")).toBeVisible();

    // (2) exactly ONE new-reply entry (a distinct, prominent row — not the grouped line)
    await expect(replyRow).toHaveCount(1);

    // (4) the routine checks are grouped and quiet, NOT per-poll rows
    await expect(page.getByRole("heading", { name: "Routine background checks" })).toBeVisible();
    await expect(page.getByText("Checked your messages")).toBeVisible();
    await expect(page.getByText("Checked the news")).toBeVisible();

    // (3) let several more 5s polls run, reopen Receipts → STILL exactly one new-reply entry
    // (old/read is never re-counted as new).
    await page.waitForTimeout(12_000);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Receipts" }).click();
    await expect(page.locator("tr.receipt-row", { hasText: "new reply from Dawid" })).toHaveCount(1);

    // ---- on-disk truth ----
    const log = readFileSync(path.join(userDataDir, "receipts.jsonl"), "utf8");
    // exactly one new-reply entry across the whole log, tagged direction:in
    const replyLines = log.split("\n").filter((l) => l.includes("new reply from Dawid"));
    expect(replyLines).toHaveLength(1);
    expect(replyLines[0]).toContain('"direction":"in"');
    // directions are stamped at the source
    expect(log).toContain('"task":"Deskhand: your message to Dawid"');
    expect(log).toMatch(/"task":"Deskhand: your message to Dawid"[^}]*"direction":"out"/);
    // the invariant holds: routine polls are STILL fully receipted on disk (just grouped in UI)
    const msgPolls = log.split("\n").filter((l) => l.includes('"task":"Deskhand: messages"') && l.includes('"routine":true'));
    expect(msgPolls.length).toBeGreaterThan(0);
    // news carries its In direction at the data layer too (grouped in the UI, authoritative on disk)
    expect(log).toMatch(/"task":"Deskhand: news"[^}]*"direction":"in"/);
    // metadata only — neither the message nor the reply body ever hit the log
    expect(log).not.toContain(MY_MESSAGE);
    expect(log).not.toContain(FOUNDER_REPLY);
    expect(log).not.toContain(FAKE_KEY);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

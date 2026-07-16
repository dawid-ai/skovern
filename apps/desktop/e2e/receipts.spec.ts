import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { AuthService, AuthStore, ConsoleMailer, startAuthServer, type RunningServer } from "@skovern/site";

// Loop 015 metric (app-level, THROUGH THE REAL app + real main + real log): sign in
// (a first-party cloud call) → connect a brain → "Test my brain" (a model call, mock
// brain, no real key) → open the Receipts page. Both must show: a first-party receipt
// (the cloud host) AND a model receipt (the brain). This proves the panel tails the
// real receipts.jsonl AND that first-party egress is now receipted (closes 013b H1).

const BRAIN_REPLY = "Hello! I'm your brain and I'm working.";
const FAKE_KEY = "sk-fake-test-key-should-never-be-logged";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let server: RunningServer;
let mailer: ConsoleMailer;
let brain: Server;
let brainUrl: string;

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
    brain.listen(0, "127.0.0.1", () => {
      const { port } = brain.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  await new AuthStore(pool).migrate();
  mailer = new ConsoleMailer();
  const auth = new AuthService(new AuthStore(pool), mailer, { appUrl: "https://app.test" });
  server = await startAuthServer({ service: auth });
  brainUrl = await startMockBrain();
});

test.afterAll(async () => {
  await server?.close();
  await pool?.end();
  await container?.stop();
  brain?.close();
});

test("the Receipts page shows a first-party cloud call and a model call", async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      SKOVERN_API_URL: server.url,
      SKOVERN_OPENROUTER_BASE_URL: brainUrl,
    },
  });

  try {
    const page = await app.firstWindow();

    // sign in — this is itself a first-party cloud call (receipted "Skovern: sign-in")
    await page.getByLabel("Your email").fill("receipts@shop.test");
    await page.getByRole("button", { name: "Send me a link" }).click();
    await expect.poll(() => mailer.sent.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.getByLabel("Paste your link").fill(mailer.sent[mailer.sent.length - 1]!.url);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText(/founding user #1/i)).toBeVisible();

    // connect a brain and test it — this is a model (brain) call, receipted
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Your key").fill(FAKE_KEY);
    await page.getByRole("button", { name: "Save brain" }).click();
    await expect(page.getByText("Brain saved.")).toBeVisible();
    await page.getByRole("button", { name: "Test my brain" }).click();
    await expect(page.getByText(BRAIN_REPLY)).toBeVisible({ timeout: 20_000 });

    // open the Receipts page — both kinds of egress are listed, newest first
    await page.getByRole("button", { name: "Receipts" }).click();
    await expect(page.getByRole("heading", { name: "What leaves your machine" })).toBeVisible();

    const list = page.locator(".receipt-list");
    // a first-party receipt (sign-in), shown as "Skovern"
    await expect(list.locator(".receipt-who", { hasText: "Skovern" }).first()).toBeVisible();
    // a model receipt (the brain), shown as "Your brain" going to OpenRouter
    await expect(list.locator(".receipt-who", { hasText: "Your brain" }).first()).toBeVisible();
    await expect(list.getByText("OpenRouter").first()).toBeVisible();

    // the on-disk log proves it — metadata only, no key, no secret
    const log = readFileSync(path.join(userDataDir, "receipts.jsonl"), "utf8");
    expect(log).toContain('"task":"Skovern: sign-in"');
    expect(log).toContain('"provider":"openrouter"');
    expect(log).not.toContain(FAKE_KEY);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

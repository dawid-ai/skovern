import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { AuthService, AuthStore, ConsoleMailer, startAuthServer, type RunningServer } from "@deskhand/site";

// Loop 011 metric (app-level): the brain picker THROUGH THE REAL APP — sign in,
// open Settings, save a key, "Test my brain" does a real round-trip (against a
// mock OpenAI-compatible server, so no network/real key in CI), the reply shows,
// and a receipt line + a receipts.jsonl entry prove exactly what left the machine.

const BRAIN_REPLY = "Hello! I'm your brain and I'm working.";
const FAKE_KEY = "sk-fake-test-key-should-never-be-logged";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let server: RunningServer;
let mailer: ConsoleMailer;
let brain: Server;
let brainUrl: string;

// A tiny OpenAI-compatible endpoint. The REAL openRouterProvider (AI SDK) posts
// to `${baseURL}/chat/completions`; we answer with a normal chat completion.
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
            choices: [
              { index: 0, message: { role: "assistant", content: BRAIN_REPLY }, finish_reason: "stop" },
            ],
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

test("user connects a brain in Settings and tests it, seeing the reply + a receipt", async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "deskhand-e2e-"));
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      DESKHAND_API_URL: server.url,
      // point the real OpenRouter (OpenAI-compatible) adapter at the mock
      DESKHAND_OPENROUTER_BASE_URL: brainUrl,
    },
  });

  try {
    const page = await app.firstWindow();

    // sign in
    await page.getByLabel("Your email").fill("brain@shop.test");
    await page.getByRole("button", { name: "Send me a link" }).click();
    await expect.poll(() => mailer.sent.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.getByLabel("Paste your link").fill(mailer.sent[mailer.sent.length - 1]!.url);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText(/founding user #1/i)).toBeVisible();

    // open Settings, save a key (default brain = OpenRouter)
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await page.getByLabel("Your key").fill(FAKE_KEY);
    await page.getByRole("button", { name: "Save brain" }).click();
    await expect(page.getByText("Brain saved.")).toBeVisible();

    // test it — the mock answers, the reply and a receipt line appear
    await page.getByRole("button", { name: "Test my brain" }).click();
    await expect(page.getByText(BRAIN_REPLY)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Sent .* to OpenRouter at/)).toBeVisible();

    // the receipt hit the on-disk log — metadata only, never the key
    const log = readFileSync(path.join(userDataDir, "receipts.jsonl"), "utf8");
    expect(log).toContain('"provider":"openrouter"');
    expect(log).toContain('"task":"Test my brain"');
    expect(log).not.toContain(FAKE_KEY);
    expect(log).not.toContain(BRAIN_REPLY);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

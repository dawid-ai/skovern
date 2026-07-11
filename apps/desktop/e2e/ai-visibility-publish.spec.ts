import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
  VisibilityStore,
  type RunningServer,
} from "@deskhand/site";

// Loop 013b metric (app-level, full stack): sign in → run AI Visibility on a mock
// brain → click Publish → a public /u/visibility link appears, and fetching it
// serves a real page with the (escaped) business name + score. Proves the whole
// publish write-path end to end through the real desktop app + site server.

const ANSWER =
  "Yes! Rose & Thorn is a lovely florist in Leeds. Top options:\n```json\n[\"Petal Pushers\", \"Bloom Room\"]\n```";

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
            choices: [{ index: 0, message: { role: "assistant", content: ANSWER }, finish_reason: "stop" }],
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
  const visibility = new VisibilityStore(pool);
  await visibility.migrate();
  mailer = new ConsoleMailer();
  const auth = new AuthService(new AuthStore(pool), mailer, { appUrl: "https://app.test" });
  server = await startAuthServer({ service: auth, visibility });
  brainUrl = await startMockBrain();
});

test.afterAll(async () => {
  await server?.close();
  await pool?.end();
  await container?.stop();
  brain?.close();
});

test("user publishes an AI Visibility result and gets a live public link", async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "deskhand-e2e-"));
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: { ...process.env, DESKHAND_API_URL: server.url, DESKHAND_OPENROUTER_BASE_URL: brainUrl },
  });

  try {
    const page = await app.firstWindow();

    // sign in
    await page.getByLabel("Your email").fill("publish@shop.test");
    await page.getByRole("button", { name: "Send me a link" }).click();
    await expect.poll(() => mailer.sent.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.getByLabel("Paste your link").fill(mailer.sent[mailer.sent.length - 1]!.url);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText(/founding user #1/i)).toBeVisible();

    // connect a brain (OpenRouter → mock)
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Your brain").selectOption({ label: "OpenRouter" });
    await page.getByLabel("Your key").fill("sk-fake-key");
    await page.getByRole("button", { name: "Save brain" }).click();
    await expect(page.getByText("Brain saved.")).toBeVisible();

    // run AI Visibility
    await page.getByRole("button", { name: "Skills" }).click();
    await page.getByRole("button", { name: "Open" }).click();
    await page.getByLabel("Your business name").fill("Rose & Thorn");
    await page.getByLabel("What kind of business?").fill("florist");
    await page.getByLabel("Your town or city").fill("Leeds");
    await page.getByRole("button", { name: "Check my visibility" }).click();
    await expect(page.getByText(/AI knows you well/)).toBeVisible({ timeout: 30_000 });

    // publish it → a public link appears
    await page.getByRole("button", { name: "Publish a shareable link" }).click();
    const link = page.getByRole("link", { name: /\/u\/visibility\// });
    await expect(link).toBeVisible({ timeout: 30_000 });
    const url = await link.getAttribute("href");
    expect(url).toContain("/u/visibility/");

    // the published page is really live — escaped business name + score
    const res = await fetch(url!);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Rose &amp; Thorn");
    expect(html).toContain("100/100");

    // the share card is produced + live (an image at the stable card URL)
    const card = await fetch(`${url}/og.svg`);
    expect(card.status).toBe(200);
    expect(card.headers.get("content-type")).toMatch(/image\//);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { AuthService, AuthStore, ConsoleMailer, startAuthServer, type RunningServer } from "@deskhand/site";

// Loop 019 metric E1 (app-level, real Electron UI): sign in → Settings → "On this
// computer" → the honest verdict + "what you have" / "our suggestions" (trade-offs,
// download state, best highlighted) render against a FAKE Ollama + FAKE catalog
// (no real Ollama/GitHub in CI) → pick an already-downloaded model → run a real
// call on it → the Receipts page shows a "stayed on your computer" entry (no egress)
// AND a github catalog receipt. Also: a descriptive error when Ollama is unreachable.

const LOCAL_REPLY = "Hello from your private local brain.";

// The fake Ollama exposes /api/tags (one downloaded model) + /api/generate. Kept in
// a small object so the test can shut it down to exercise the "not running" error.
let ollama: Server | null = null;
let catalog: Server | null = null;

function startOllama(): Promise<string> {
  return new Promise((resolve) => {
    ollama = createServer((req, res) => {
      const url = req.url ?? "";
      if (req.method === "GET" && url === "/api/tags") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            models: [{ name: "qwen2.5:3b", size: 2_000_000_000, details: { quantization_level: "Q4_K_M", parameter_size: "3.1B" } }],
          }),
        );
        return;
      }
      if (req.method === "POST" && url === "/api/generate") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ response: LOCAL_REPLY }));
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
    ollama.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(ollama!.address() as AddressInfo).port}`));
  });
}

// A fake catalog server: one already-downloaded model + one that needs a download.
function startCatalog(): Promise<string> {
  return new Promise((resolve) => {
    catalog = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          models: [
            {
              id: "qwen2.5:3b",
              label: "Qwen2.5 3B",
              params: 3,
              sizeBytes: 2_000_000_000,
              quant: "Q4_K_M",
              creator: "Alibaba (Qwen team)",
              homepage: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct",
              license: "Apache 2.0 — free to use.",
              licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
              tradeoff: "A solid everyday pick — good balance of speed and smarts.",
            },
            {
              // Deliberately huge so it's RED on any machine — keeps the downloaded
              // 3B as the deterministic recommendation, and this one always lands in
              // "Other options" (the honest "too big for this computer" advanced pick).
              id: "qwen2.5:72b",
              label: "Qwen2.5 72B",
              params: 72,
              sizeBytes: 42_000_000_000,
              quant: "Q4_K_M",
              creator: "Alibaba (Qwen team)",
              homepage: "https://huggingface.co/Qwen/Qwen2.5-72B-Instruct",
              license: "Apache 2.0 — free to use.",
              licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
              tradeoff: "The smartest of these, but it needs a lot of memory.",
            },
          ],
        }),
      );
    });
    catalog.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(catalog!.address() as AddressInfo).port}/catalog/models.json`));
  });
}

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let server: RunningServer;
let mailer: ConsoleMailer;
let ollamaUrl: string;
let catalogUrl: string;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  await new AuthStore(pool).migrate();
  mailer = new ConsoleMailer();
  const auth = new AuthService(new AuthStore(pool), mailer, { appUrl: "https://app.test" });
  server = await startAuthServer({ service: auth });
  ollamaUrl = await startOllama();
  catalogUrl = await startCatalog();
});

test.afterAll(async () => {
  await server?.close();
  await pool?.end();
  await container?.stop();
  ollama?.close();
  catalog?.close();
});

test("user sets up a private on-computer brain, runs it, and sees a 'stayed on your computer' receipt", async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "deskhand-e2e-"));
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      DESKHAND_API_URL: server.url,
      DESKHAND_OLLAMA_URL: ollamaUrl,
      DESKHAND_CATALOG_URL: catalogUrl,
    },
  });

  try {
    const page = await app.firstWindow();

    // sign in
    await page.getByLabel("Your email").fill("local@shop.test");
    await page.getByRole("button", { name: "Send me a link" }).click();
    await expect.poll(() => mailer.sent.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.getByLabel("Paste your link").fill(mailer.sent[mailer.sent.length - 1]!.url);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText(/founding user #1/i)).toBeVisible();

    // Settings → pick the local brain → open its dedicated setup view
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Your brain").selectOption("local");
    await page.getByRole("button", { name: "Set up the local brain →" }).click();

    // the honest verdict + a hardware line render
    await expect(page.getByRole("heading", { name: "On this computer" })).toBeVisible();
    await expect(page.getByText(/private brain|cloud brain|subscription/i).first()).toBeVisible({ timeout: 30_000 });

    // ONE obvious pick up front: the single recommendation renders as the hero, with
    // its trade-off, download state, best-highlight, and transparency line — no
    // decision to make.
    await expect(page.getByRole("heading", { name: "Our pick for your computer" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Qwen2.5 3B" })).toBeVisible();
    await expect(page.getByText(/A solid everyday pick/)).toBeVisible();
    await expect(page.getByText("Already on your computer").first()).toBeVisible();
    await expect(page.getByText("Best for your computer").first()).toBeVisible();
    await expect(page.getByText(/Made by Alibaba .* not by Deskhand/).first()).toBeVisible();

    // the OTHER model is folded away by default — not shown until "Other options" opens
    await expect(page.getByText("Qwen2.5 72B")).toBeHidden();
    await page.getByText("Other options", { exact: true }).click();
    await expect(page.getByText("Qwen2.5 72B")).toBeVisible();
    // a not-yet-downloaded model offers "Get this one" (same one-click action the hero
    // shows when the recommendation isn't downloaded — proven here since 72B isn't)
    await expect(page.getByRole("button", { name: "Get this one" })).toBeVisible();

    // pick the already-downloaded recommendation as the brain (one click)
    await page.getByRole("button", { name: "Use this one" }).first().click();
    await expect(page.getByRole("button", { name: "This is your brain ✓" })).toBeVisible();

    // back to Settings, run a real call on the local brain (Test my brain)
    await page.getByRole("button", { name: "← Back to Settings" }).click();
    await page.getByRole("button", { name: "Test my brain" }).click();
    await expect(page.getByText(LOCAL_REPLY)).toBeVisible({ timeout: 30_000 });

    // Receipts page: the local run "stayed on your computer" (no egress), and the
    // catalog fetch left a github/model-list receipt.
    await page.getByRole("button", { name: "Receipts" }).click();
    await expect(page.getByText("stayed on your computer — nothing left").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("model list").first()).toBeVisible();

    // on-disk proof: a local:true model receipt + a receipted catalog fetch, and the
    // reply body never touched the log.
    const log = readFileSync(path.join(userDataDir, "receipts.jsonl"), "utf8");
    expect(log).toContain('"provider":"local"');
    expect(log).toContain('"local":true');
    expect(log).toContain('"task":"Deskhand: model list"');
    expect(log).not.toContain(LOCAL_REPLY);

    // descriptive error when Ollama becomes unreachable: stop the fake server, reopen
    // the setup view, and the plain-language "isn't running" message shows.
    await new Promise<void>((resolve) => (ollama ? ollama.close(() => resolve()) : resolve()));
    ollama = null;
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Set up the local brain →" }).click();
    await expect(page.getByText(/Ollama isn't running/i).first()).toBeVisible({ timeout: 30_000 });
    // and NO hero pick is shown when Ollama is down — the verdict still scores the
    // catalog, but there's nothing to click, so we don't dangle a dead button.
    await expect(page.getByRole("heading", { name: "Our pick for your computer" })).toBeHidden();
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

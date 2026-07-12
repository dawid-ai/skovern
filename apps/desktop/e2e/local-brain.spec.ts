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

// A fixed CPU-only machine so the verdict is deterministic on ANY runner (CI is
// CPU-only; a dev box may have a big GPU). With 16 GB RAM and no usable GPU:
// mistral:7b + qwen2.5:3b are amber (usable), qwen2.5:235b is red — so the pulled
// mistral:7b is always the biggest-usable recommendation. Fed via the DESKHAND_HARDWARE
// dev/test seam (inert when packaged).
const CPU_HARDWARE = JSON.stringify({
  ramBytes: 16 * 1024 ** 3,
  cpuCores: 8,
  gpus: [],
  bestVramBytes: null,
  unifiedMemory: false,
  diskFreeBytes: 200 * 1024 ** 3,
  notes: [],
});

// The fake Ollama exposes /api/tags (one downloaded model) + /api/generate. Kept in
// a small object so the test can shut it down to exercise the "not running" error.
let ollama: Server | null = null;
let catalog: Server | null = null;

function startOllama(): Promise<string> {
  return new Promise((resolve) => {
    ollama = createServer((req, res) => {
      const url = req.url ?? "";
      if (req.method === "GET" && url === "/api/tags") {
        // The user's OWN pulled model — NOT in the catalog — and big enough to be the
        // best fit. This is what surfaces the 019 contradiction: the catalog-only
        // verdict (old headline) would pick a smaller catalog model, while the
        // catalog+own verdict (the hero) picks this. Post-fix they must agree.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            models: [{ name: "mistral:7b", size: 4_700_000_000, details: { quantization_level: "Q4_K_M", parameter_size: "7B" } }],
          }),
        );
        return;
      }
      if (req.method === "POST" && url === "/api/generate") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ response: LOCAL_REPLY }));
        return;
      }
      if (req.method === "POST" && url === "/api/pull") {
        // Stream a tick of progress then success (NDJSON), so "Get this one" resolves.
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(JSON.stringify({ status: "pulling", completed: 50_000_000, total: 100_000_000 }) + "\n");
        res.end(JSON.stringify({ status: "success" }) + "\n");
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
    ollama.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(ollama!.address() as AddressInfo).port}`));
  });
}

// A fake catalog: a smaller green suggestion (needs a download → exercises
// "Get this one" download-and-use) + an always-red huge one. Neither is the user's
// own model, so the best fit is the pulled `mistral:7b` above — that's the point.
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
              // Deliberately enormous (235B, ~140 GB) so its footprint exceeds any
              // realistic machine's memory → RED everywhere (CPU CI and big dGPU hosts
              // alike), so it's always an "Other options" pick, never the recommendation.
              id: "qwen2.5:235b",
              label: "Qwen2.5 235B",
              params: 235,
              sizeBytes: 140_000_000_000,
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

test("user sets up a private on-computer brain, always sees which brain is active, and runs it", async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "deskhand-e2e-"));
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      DESKHAND_API_URL: server.url,
      DESKHAND_OLLAMA_URL: ollamaUrl,
      DESKHAND_CATALOG_URL: catalogUrl,
      DESKHAND_HARDWARE: CPU_HARDWARE,
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

    // the always-visible active-brain readout starts empty for a fresh user
    await expect(page.getByText("No brain yet")).toBeVisible();

    // Settings → pick the local brain → open its dedicated setup view
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Your brain").selectOption("local");
    await page.getByRole("button", { name: "Set up the local brain →" }).click();

    // the honest verdict + a hardware line render
    await expect(page.getByRole("heading", { name: "On this computer" })).toBeVisible();
    await expect(page.getByText(/private brain|cloud brain|subscription/i).first()).toBeVisible({ timeout: 30_000 });

    // CONSISTENCY (regression for the 019 contradiction): the verdict headline names
    // the SAME model as the "Our pick" hero. The user's own mistral:7b outranks the
    // catalog picks, so it's the recommendation — before the fix, the headline (scored
    // over the catalog ONLY) would name a catalog model while the hero named mistral.
    // Asserted wording-independently (the headline copy differs on a green vs amber
    // machine — CI is CPU-only — but the MODEL it names must match the hero either way).
    await expect(page.getByRole("heading", { name: "Our pick for your computer" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "mistral:7b" })).toBeVisible();
    await expect(page.locator(".local-headline")).toContainText("mistral:7b");
    await expect(page.getByText("Already on your computer").first()).toBeVisible();
    await expect(page.getByText("Best for your computer").first()).toBeVisible();

    // everything else folds under "Other options" (hidden by default)
    await expect(page.getByText("Qwen2.5 235B")).toBeHidden();
    await expect(page.getByRole("heading", { name: "Qwen2.5 3B" })).toBeHidden();
    await page.getByText("Other options", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "Qwen2.5 3B" })).toBeVisible();
    await expect(page.getByText(/Made by Alibaba .* not by Deskhand/).first()).toBeVisible();

    // pick the recommended hero (mistral:7b, already downloaded) — one click
    await page.getByRole("button", { name: "Use this one" }).first().click();
    await expect(page.getByRole("button", { name: "This is your brain ✓" })).toBeVisible();

    // ACTIVE-BRAIN WIDGET: the compact sidebar readout (above "Sign out") names the
    // provider + model, and updated the instant we picked.
    await expect(page.getByText("Local: mistral:7b")).toBeVisible({ timeout: 10_000 });

    // back to Settings: the "right now you're using" line names the active provider+model
    await page.getByRole("button", { name: "← Back to Settings" }).click();
    await expect(page.locator(".active-brain")).toContainText("On this computer");
    await expect(page.locator(".active-brain")).toContainText("mistral:7b");

    // run a real call on the local brain (Test my brain)
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

    // IN-USE MARKER ON LOAD: reopening the local setup shows the active model as in use
    // ("This is your brain ✓") without clicking anything.
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Set up the local brain →" }).click();
    await expect(page.getByRole("button", { name: "This is your brain ✓" })).toBeVisible({ timeout: 30_000 });

    // DOWNLOAD-AND-USE IN ONE CLICK: "Get this one" on a not-downloaded model (Qwen2.5
    // 3B, under Other options) pulls AND selects it — the sidebar flips to the new model.
    await page.getByText("Other options", { exact: true }).click();
    await page.getByRole("button", { name: "Get this one" }).first().click();
    await expect(page.getByText("Local: qwen2.5:3b")).toBeVisible({ timeout: 30_000 });

    // descriptive error when Ollama becomes unreachable: stop the fake server, reopen
    // the setup view → plain-language "isn't running" + NO dangling hero pick.
    await new Promise<void>((resolve) => (ollama ? ollama.close(() => resolve()) : resolve()));
    ollama = null;
    await page.getByRole("button", { name: "← Back to Settings" }).click();
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

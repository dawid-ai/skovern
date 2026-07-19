import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { AuthService, AuthStore, ConsoleMailer, startAuthServer, type RunningServer } from "@skovern/site";

// Loop 041 — "Your models": see what's downloaded (disk) + loaded (VRAM), delete to reclaim disk,
// free memory to reclaim VRAM. Native runtime + download fixtured, so PASS/FAIL is a pure function
// of the diff; the real VRAM actually dropping is hand-validation.

const FAKE_REPLY = "Hello — I'm your private brain, running right here on your computer.";
const GGUF_FILENAME = "qwen2.5-3b-instruct-q4_k_m.gguf";
const MODEL_BODY = Buffer.from("FAKE-GGUF-BYTES-for-the-model-manage-e2e".repeat(50));
const MODEL_SHA256 = createHash("sha256").update(MODEL_BODY).digest("hex");

const GPU_HARDWARE = JSON.stringify({
  ramBytes: 64 * 1024 ** 3, cpuCores: 16, gpus: [{ model: "Test GPU 24GB", vramBytes: 24 * 1024 ** 3 }],
  bestVramBytes: 24 * 1024 ** 3, unifiedMemory: false, diskFreeBytes: 500 * 1024 ** 3, notes: [],
});

let catalog: Server | null = null;
let download: Server | null = null;

function startCatalog(): Promise<string> {
  return new Promise((resolve) => {
    catalog = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        models: [{
          id: "qwen2.5:3b", label: "Qwen2.5 3B", params: 3, sizeBytes: MODEL_BODY.length, quant: "Q4_K_M",
          creator: "Alibaba (Qwen team)", homepage: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF",
          license: "Apache 2.0 — free to use.", licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
          tradeoff: "A strong little all-rounder.",
          gguf: { url: `https://huggingface.co/x/resolve/main/${GGUF_FILENAME}`, sha256: MODEL_SHA256, sizeBytes: MODEL_BODY.length, filename: GGUF_FILENAME, contextSize: 4096 },
        }],
      }));
    });
    catalog.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(catalog!.address() as AddressInfo).port}/catalog/models.json`));
  });
}

function startDownload(): Promise<string> {
  return new Promise((resolve) => {
    download = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(MODEL_BODY);
    });
    download.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(download!.address() as AddressInfo).port}/${GGUF_FILENAME}`));
  });
}

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let server: RunningServer;
let mailer: ConsoleMailer;
let catalogUrl: string;
let downloadUrl: string;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  await new AuthStore(pool).migrate();
  mailer = new ConsoleMailer();
  const auth = new AuthService(new AuthStore(pool), mailer, { appUrl: "https://app.test" });
  server = await startAuthServer({ service: auth });
  catalogUrl = await startCatalog();
  downloadUrl = await startDownload();
});

test.afterAll(async () => {
  await server?.close();
  await pool?.end();
  await container?.stop();
  catalog?.close();
  download?.close();
});

async function signIn(page: Page, email: string): Promise<void> {
  const before = mailer.sent.length;
  await page.getByLabel("Your email").fill(email);
  await page.getByRole("button", { name: "Send me a link" }).click();
  await expect.poll(() => mailer.sent.length, { timeout: 30_000 }).toBeGreaterThan(before);
  await page.getByLabel("Paste your link").fill(mailer.sent[mailer.sent.length - 1]!.url);
  await page.getByRole("button", { name: "Verify" }).click();
}

// Open Settings → the local-brain setup view (where "Your models" lives) and download the 3B.
async function setUpAndOpenLocal(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Your brain").selectOption("local");
  await page.getByRole("button", { name: "Set up the local brain →" }).click();
  await expect(page.getByRole("heading", { name: "On this computer" })).toBeVisible();
  await page.getByRole("button", { name: "Get this one" }).first().click();
  await expect(page.getByText("Local: qwen2.5:3b")).toBeVisible({ timeout: 60_000 });
}

test("Your models: list downloaded, free memory, and delete to reclaim disk", async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const modelFile = path.join(userDataDir, "models", GGUF_FILENAME);
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      SKOVERN_API_URL: server.url,
      SKOVERN_OLLAMA_URL: "http://127.0.0.1:1",
      SKOVERN_OLLAMA_INSTALLED: "0",
      SKOVERN_CATALOG_URL: catalogUrl,
      SKOVERN_HARDWARE: GPU_HARDWARE,
      SKOVERN_LLAMA_FAKE: "1",
      SKOVERN_MODEL_DOWNLOAD_URL: downloadUrl,
    },
  });
  try {
    const page = await app.firstWindow();
    await signIn(page, "models@shop.test");
    await setUpAndOpenLocal(page);

    const your = page.locator(".your-models");
    const row = your.locator("tr.receipt-row", { hasText: "Qwen2.5 3B" });

    // E1: the downloaded 3B is listed with a human size and a Delete action; it's marked in-use.
    await expect(your.getByRole("heading", { name: "Your models" })).toBeVisible();
    await expect(row).toBeVisible();
    await expect(row).toContainText(/GB|MB|KB|B/); // a size on disk
    await expect(row.getByText("in use")).toBeVisible(); // it's the active brain
    expect(existsSync(modelFile)).toBe(true);

    // E3: warm the model (a real chat generate), then FREE MEMORY unloads it.
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByLabel("Message your brain").fill("hi");
    await page.getByLabel("Message your brain").press("Enter");
    await expect(page.locator(".chat-thread .from-brain p").last()).toHaveText(FAKE_REPLY, { timeout: 30_000 });
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Set up the local brain →" }).click();
    await expect(your.getByText(/In memory now/i)).toBeVisible({ timeout: 15_000 });
    await your.getByRole("button", { name: "Free memory" }).click();
    await expect(your.getByText(/Nothing is loaded in memory/i)).toBeVisible({ timeout: 15_000 });

    // E2: DELETE reclaims disk — confirm inline, the row disappears, the file is gone.
    await row.getByRole("button", { name: "Delete" }).click();
    await row.getByRole("button", { name: "Yes, delete" }).click();
    await expect(row).toHaveCount(0, { timeout: 15_000 });
    expect(existsSync(modelFile)).toBe(false); // disk reclaimed
    await expect(your.getByText(/haven't downloaded any brains/i)).toBeVisible();
    // U3/E2: deleting the ACTIVE model cleared the brain — no dangling pointer at a deleted file.
    const status = await page.evaluate(() => window.skovern.brain.status());
    expect(status.configured).toBe(false);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

// Loop 043 — BUG B + BUG C. Free memory must show + actually free for the OLLAMA path (not just
// embedded), and "Your models" must say where the downloaded brains live.
test("Your models: Free memory shows + frees an Ollama-loaded brain, and the models folder is shown", async () => {
  test.setTimeout(180_000);
  // A fake Ollama that has a model RESIDENT (/api/ps) until we unload it with keep_alive:0.
  let residentModel: string | null = "mistral:7b";
  const unloads: string[] = []; // models the app asked Ollama to unload
  const ollama = createServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/api/ps") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: residentModel ? [{ name: residentModel }] : [] }));
      return;
    }
    if (req.method === "GET" && url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [] })); // no pulled models — residence is the only signal
      return;
    }
    if (req.method === "POST" && url === "/api/generate") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          const b = JSON.parse(raw) as { model?: string; keep_alive?: number };
          if (b.keep_alive === 0) {
            unloads.push(b.model ?? "");
            if (b.model === residentModel) residentModel = null; // Ollama drops it from memory
          }
        } catch {
          /* ignore */
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ response: "", done: true }));
      });
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((r) => ollama.listen(0, "127.0.0.1", () => r()));
  const ollamaUrl = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;

  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      SKOVERN_API_URL: server.url,
      SKOVERN_OLLAMA_URL: ollamaUrl,
      SKOVERN_OLLAMA_INSTALLED: "1",
      SKOVERN_CATALOG_URL: catalogUrl,
      SKOVERN_HARDWARE: GPU_HARDWARE,
      // NO SKOVERN_LLAMA_FAKE: there is NO warm embedded child — the resident brain is Ollama's,
      // exactly the pre-fix case where the Free memory button was invisible.
    },
  });
  try {
    const page = await app.firstWindow();
    await signIn(page, "ollamafree@shop.test");
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Your brain").selectOption("local");
    await page.getByRole("button", { name: "Set up the local brain →" }).click();
    await expect(page.getByRole("heading", { name: "On this computer" })).toBeVisible();

    const your = page.locator(".your-models");

    // BUG C (E-model-home): the panel says these are downloaded HERE (not Ollama's), shows the real
    // models-folder path, and offers a "Show in folder" button.
    await expect(your.getByText(/downloaded onto this computer/i)).toBeVisible();
    await expect(your.getByText(/aren't shown or managed here/i)).toBeVisible();
    await expect(your.locator(".your-models-folder code")).toContainText(path.join(userDataDir, "models"));
    await expect(your.getByRole("button", { name: "Show in folder" })).toBeVisible();

    // BUG B (E-ollama-free): Ollama has a model RESIDENT and NO embedded child is warm → the Memory
    // row shows it + a Free memory button (pre-fix this was invisible for the Ollama path).
    await expect(your.getByText(/In memory now/i)).toBeVisible({ timeout: 15_000 });
    await expect(your.getByText("mistral:7b")).toBeVisible();
    await your.getByRole("button", { name: "Free memory" }).click();

    // The app told Ollama to unload it (keep_alive:0) and the row now reads nothing loaded.
    await expect(your.getByText(/Nothing is loaded in memory/i)).toBeVisible({ timeout: 15_000 });
    expect(unloads).toContain("mistral:7b");
  } finally {
    await app.close();
    ollama.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

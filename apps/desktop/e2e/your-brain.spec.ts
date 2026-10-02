import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { AuthService, AuthStore, ConsoleMailer, startAuthServer, type RunningServer } from "@skovern/site";

// Loop 045 — "Your brain": its own nav page for the brains on this computer (moved out of
// Settings, B3), switching brains frees the old one (B1), and a failed download says what
// happened with a Try again (B2). The 041/043 "Your models" assertions moved here from the retired
// model-manage.spec.ts — same intents, reached by the nav instead of Settings → local setup.
// Native runtime, Ollama, catalog, hardware, and download are all fixtured: PASS/FAIL is a pure
// function of the diff. The real VRAM number dropping is hand-validation.

const FAKE_REPLY = "Hello — I'm your private brain, running right here on your computer.";
const GGUF_FILENAME = "qwen2.5-3b-instruct-q4_k_m.gguf";
const MODEL_BODY = Buffer.from("FAKE-GGUF-BYTES-for-the-your-brain-e2e".repeat(2000));
const MODEL_SHA256 = createHash("sha256").update(MODEL_BODY).digest("hex");
const STOPPED = "The download stopped";

const GPU_HARDWARE = JSON.stringify({
  ramBytes: 64 * 1024 ** 3, cpuCores: 16, gpus: [{ model: "Test GPU 24GB", vramBytes: 24 * 1024 ** 3 }],
  bestVramBytes: 24 * 1024 ** 3, unifiedMemory: false, diskFreeBytes: 500 * 1024 ** 3, notes: [],
});

let catalog: Server | null = null;
let download: Server | null = null;
// E4: while true, the download fixture sends half the body then drops the connection — the exact
// shape that made undici throw its raw `TypeError: terminated` on Dawid's first download.
let dropDownload = false;
// Finding 4 (checker, iteration 1): when true, the live catalog RENAMES the 3B (new id + new file) —
// the "catalog lost the active model's entry" case the stored filename must survive.
let remapCatalog = false;
const REMAPPED = { id: "qwen2.5:3b-v2", label: "Qwen2.5 3B v2", filename: "qwen2.5-3b-v2-instruct-q4_k_m.gguf" };

function startCatalog(): Promise<string> {
  return new Promise((resolve) => {
    catalog = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const m = remapCatalog ? REMAPPED : { id: "qwen2.5:3b", label: "Qwen2.5 3B", filename: GGUF_FILENAME };
      res.end(JSON.stringify({
        models: [{
          id: m.id, label: m.label, params: 3, sizeBytes: MODEL_BODY.length, quant: "Q4_K_M",
          creator: "Alibaba (Qwen team)", homepage: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF",
          license: "Apache 2.0 — free to use.", licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
          tradeoff: "A strong little all-rounder.",
          gguf: { url: `https://huggingface.co/x/resolve/main/${m.filename}`, sha256: MODEL_SHA256, sizeBytes: MODEL_BODY.length, filename: m.filename, contextSize: 4096 },
        }],
      }));
    });
    catalog.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(catalog!.address() as AddressInfo).port}/catalog/models.json`));
  });
}

function startDownload(): Promise<string> {
  return new Promise((resolve) => {
    download = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(MODEL_BODY.length) });
      if (dropDownload) {
        res.write(MODEL_BODY.subarray(0, MODEL_BODY.length / 2), () => setImmediate(() => res.socket?.destroy()));
        return;
      }
      res.end(MODEL_BODY);
    });
    download.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(download!.address() as AddressInfo).port}/${GGUF_FILENAME}`));
  });
}

// A fake loopback Ollama: `mistral:7b` is pulled (/api/tags); `resident` is what /api/ps reports
// loaded; a keep_alive:0 /api/generate unloads it and is recorded in `unloads`.
function startOllama(initialResident: string | null): Promise<{ url: string; server: Server; state: { resident: string | null; unloads: string[] } }> {
  const state = { resident: initialResident, unloads: [] as string[] };
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    const json = (body: unknown): void => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && url === "/api/ps") return json({ models: state.resident ? [{ name: state.resident }] : [] });
    if (req.method === "GET" && url === "/api/tags") return json({ models: [{ name: "mistral:7b", size: 4_100_000_000 }] });
    if (req.method === "GET" && (url === "/" || url === "/api/version")) return json({ version: "0.0.0-fixture" });
    if (req.method === "POST" && url === "/api/generate") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          const b = JSON.parse(raw) as { model?: string; keep_alive?: number };
          if (b.keep_alive === 0) {
            state.unloads.push(b.model ?? "");
            if (b.model === state.resident) state.resident = null;
          }
        } catch {
          /* ignore */
        }
        json({ response: "", done: true });
      });
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, state })));
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

test.beforeEach(() => {
  dropDownload = false;
  remapCatalog = false;
});

async function signIn(page: Page, email: string): Promise<void> {
  const before = mailer.sent.length;
  await page.getByLabel("Your email").fill(email);
  await page.getByRole("button", { name: "Send me a link" }).click();
  await expect.poll(() => mailer.sent.length, { timeout: 30_000 }).toBeGreaterThan(before);
  await page.getByLabel("Paste your link").fill(mailer.sent[mailer.sent.length - 1]!.url);
  await page.getByRole("button", { name: "Verify" }).click();
}

function launch(userDataDir: string, env: Record<string, string>): Promise<ElectronApplication> {
  return electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      SKOVERN_API_URL: server.url,
      SKOVERN_CATALOG_URL: catalogUrl,
      SKOVERN_HARDWARE: GPU_HARDWARE,
      SKOVERN_MODEL_DOWNLOAD_URL: downloadUrl,
      ...env,
    },
  });
}

async function openLocalSetup(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Pick a brain").selectOption("local");
  await page.getByRole("button", { name: "Set up the local brain →" }).click();
  await expect(page.getByRole("heading", { name: "On this computer", exact: true })).toBeVisible();
}

async function openYourBrain(page: Page): Promise<void> {
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Your brain", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your brain", level: 1 })).toBeVisible();
}

async function chatOnce(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByLabel("Message your brain").fill("hi");
  await page.getByLabel("Message your brain").press("Enter");
  await expect(page.locator(".chat-thread .from-brain p").last()).toHaveText(FAKE_REPLY, { timeout: 30_000 });
}

test("Your brain page: empty state, list, memory agrees with the chip, free memory, delete — at a short window too", async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const modelFile = path.join(userDataDir, "models", GGUF_FILENAME);
  const app = await launch(userDataDir, { SKOVERN_OLLAMA_URL: "http://127.0.0.1:1", SKOVERN_OLLAMA_INSTALLED: "0", SKOVERN_LLAMA_FAKE: "1" });
  try {
    const page = await app.firstWindow();
    await signIn(page, "yourbrain@shop.test");
    const your = page.locator(".your-models");

    // E3 (degraded): nothing downloaded → an honest empty state with a CTA, and no Free memory
    // button at all (nothing is loaded — no dead button).
    await openYourBrain(page);
    await expect(your.getByText(/haven't downloaded any private brains/i)).toBeVisible();
    await expect(your.getByText(/Nothing is loaded in memory/i)).toBeVisible();
    await expect(your.getByRole("button", { name: "Free memory" })).toHaveCount(0);
    // The CTA actually leads somewhere: the private-brain setup (and you can step back out).
    await your.getByRole("button", { name: "Get a private brain" }).click();
    await expect(page.getByRole("heading", { name: "Let's set up your brain." })).toBeVisible();
    await page.getByRole("button", { name: "I'd rather use an online brain" }).click();

    // Download the 3B from Settings. E1: the setup screen no longer hosts "Your models"; it links
    // to the new page instead.
    await openLocalSetup(page);
    await page.getByRole("button", { name: "Get this one" }).first().click();
    await expect(page.getByText("Local: qwen2.5:3b")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".your-models")).toHaveCount(0);
    await page.getByRole("button", { name: "Your brain →" }).click();
    await expect(page.getByRole("heading", { name: "Your brain", level: 1 })).toBeVisible();

    // E1 (moved from 041 E1 + 043 E-model-home): listed with a size, marked in use, folder shown.
    const row = your.locator("tr.receipt-row", { hasText: "Qwen2.5 3B" });
    await expect(your.getByRole("heading", { name: "Downloaded brains" })).toBeVisible();
    await expect(row).toBeVisible();
    await expect(row).toContainText(/GB|MB|KB|B/);
    await expect(row.getByText("in use")).toBeVisible();
    await expect(your.locator(".your-models-folder code")).toContainText(path.join(userDataDir, "models"));
    await expect(your.getByRole("button", { name: "Show in folder" })).toBeVisible();
    expect(existsSync(modelFile)).toBe(true);

    // E2 (single source of truth) + moved 041 E3: warm the model with a real chat → the page and
    // the sidebar chip BOTH say loaded; Free memory → BOTH say not loaded.
    await chatOnce(page);
    await openYourBrain(page);
    await expect(your.getByText(/In memory now/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".brain-chip")).toHaveClass(/brain-chip-local/);

    // E6 (viewport, retro 037): at 900×520, WHILE a model is loaded, the table row, folder path,
    // Delete, Show in folder AND Free memory are all reachable — the page scrolls vertically, and
    // nothing overflows sideways, neither the page nor the table's own scroll box.
    await app.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ width: 900, height: 520 }));
    for (const el of [
      row,
      your.locator(".your-models-folder code"),
      row.getByRole("button", { name: "Delete" }),
      your.getByRole("button", { name: "Show in folder" }),
      your.getByRole("button", { name: "Free memory" }),
    ]) {
      await el.scrollIntoViewIfNeeded();
      await expect(el).toBeInViewport();
    }
    const overflow = await page.evaluate(() => {
      const box = document.querySelector(".your-models .receipt-scroll");
      return {
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        table: box ? box.scrollWidth - box.clientWidth : 0,
      };
    });
    expect(overflow.page).toBeLessThanOrEqual(0);
    expect(overflow.table).toBeLessThanOrEqual(0);

    await your.getByRole("button", { name: "Free memory" }).click();
    await expect(your.getByText(/Nothing is loaded in memory/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".brain-chip")).toHaveClass(/brain-chip-asleep/, { timeout: 15_000 });

    // Moved 041 E2: DELETE reclaims disk and clears the active brain — no dangling pointer.
    await row.getByRole("button", { name: "Delete" }).click();
    await row.getByRole("button", { name: "Yes, delete" }).click();
    await expect(row).toHaveCount(0, { timeout: 15_000 });
    expect(existsSync(modelFile)).toBe(false);
    await expect(your.getByText(/haven't downloaded any private brains/i)).toBeVisible();
    const status = await page.evaluate(() => window.skovern.brain.status());
    expect(status.configured).toBe(false);

    // Fixture realism (contract): the real app's routine poll noise is in the receipts log while
    // all of this ran — nothing here read a clean, noise-free subset.
    expect(readFileSync(path.join(userDataDir, "receipts.jsonl"), "utf8")).toContain("\"routine\":true");
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

// Moved from model-manage.spec (043 BUG B + BUG C): an Ollama-resident model shows on the page and
// Free memory sends keep_alive:0 for it; the page says these brains are Skovern's, not Ollama's.
test("Your brain page: Free memory shows + frees an Ollama-loaded model, and says where brains live", async () => {
  test.setTimeout(180_000);
  const ollama = await startOllama("mistral:7b");
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  // NO SKOVERN_LLAMA_FAKE: no warm embedded child — the resident model is Ollama's.
  const app = await launch(userDataDir, { SKOVERN_OLLAMA_URL: ollama.url, SKOVERN_OLLAMA_INSTALLED: "1" });
  try {
    const page = await app.firstWindow();
    await signIn(page, "ollamafree@shop.test");
    await openYourBrain(page);
    const your = page.locator(".your-models");

    await expect(your.getByText(/downloaded onto this computer/i)).toBeVisible();
    await expect(your.getByText(/aren't shown or managed here/i)).toBeVisible();
    await expect(your.locator(".your-models-folder code")).toContainText(path.join(userDataDir, "models"));
    await expect(your.getByRole("button", { name: "Show in folder" })).toBeVisible();

    await expect(your.getByText(/In memory now/i)).toBeVisible({ timeout: 15_000 });
    await expect(your.getByText("mistral:7b")).toBeVisible();
    await your.getByRole("button", { name: "Free memory" }).click();
    await expect(your.getByText(/Nothing is loaded in memory/i)).toBeVisible({ timeout: 15_000 });
    expect(ollama.state.unloads).toContain("mistral:7b");
  } finally {
    await app.close();
    ollama.server.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

// E5 (B1, end to end): switching brains frees the outgoing one, in both directions.
test("switching brains frees the old one: built-in → Ollama, then Ollama → built-in", async () => {
  test.setTimeout(240_000);
  const ollama = await startOllama(null);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const app = await launch(userDataDir, { SKOVERN_OLLAMA_URL: ollama.url, SKOVERN_OLLAMA_INSTALLED: "1", SKOVERN_LLAMA_FAKE: "1" });
  try {
    const page = await app.firstWindow();
    await signIn(page, "switch@shop.test");
    const your = page.locator(".your-models");

    // The built-in 3B, downloaded and warm (a real chat) — Dawid's exact starting state.
    await openLocalSetup(page);
    await page.getByRole("button", { name: "Get this one" }).first().click();
    await expect(page.getByText("Local: qwen2.5:3b")).toBeVisible({ timeout: 60_000 });
    await chatOnce(page);
    await openYourBrain(page);
    await expect(your.getByText(/In memory now/i)).toBeVisible({ timeout: 15_000 });

    // Switch to the Ollama model → the built-in is no longer resident (pre-fix: "In memory now:
    // A built-in brain" stayed, stacking in VRAM next to the new one).
    await openLocalSetup(page);
    await page.locator("tr.receipt-row", { hasText: "mistral:7b" }).getByRole("button", { name: "Use this one" }).click();
    await expect(page.getByText("Local: mistral:7b")).toBeVisible({ timeout: 15_000 });
    await openYourBrain(page);
    await expect(your.getByText(/Nothing is loaded in memory/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".brain-chip")).toHaveClass(/brain-chip-asleep/, { timeout: 15_000 }); // both flip

    // Ollama loads mistral (as a chat would) → page and chip agree it's loaded.
    ollama.state.resident = "mistral:7b";
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await openYourBrain(page);
    await expect(your.getByText("mistral:7b")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".brain-chip")).toHaveClass(/brain-chip-local/, { timeout: 15_000 });

    // Switch back to the built-in → Ollama is told to unload mistral (keep_alive:0).
    await openLocalSetup(page);
    await page.locator("tr.receipt-row", { hasText: "Qwen2.5 3B" }).getByRole("button", { name: "Use this one" }).click();
    await expect(page.getByText("Local: qwen2.5:3b")).toBeVisible({ timeout: 15_000 });
    expect(ollama.state.unloads).toContain("mistral:7b");
    await openYourBrain(page);
    await expect(your.getByText(/Nothing is loaded in memory/i)).toBeVisible({ timeout: 15_000 });
  } finally {
    await app.close();
    ollama.server.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

// E4 (B2, degraded): the connection drops mid-download → a visible plain-language error with a
// Try again, never a bar stuck at 0% and never the raw word "terminated". Try again then finishes.
test("a failed download says what happened and Try again finishes it", async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const app = await launch(userDataDir, { SKOVERN_OLLAMA_URL: "http://127.0.0.1:1", SKOVERN_OLLAMA_INSTALLED: "0", SKOVERN_LLAMA_FAKE: "1" });
  try {
    const page = await app.firstWindow();
    await signIn(page, "dropped@shop.test");
    await openLocalSetup(page);

    dropDownload = true;
    await page.getByRole("button", { name: "Get this one" }).first().click();
    const alert = page.getByRole("alert").filter({ hasText: STOPPED }).first();
    await expect(alert).toBeVisible({ timeout: 30_000 });
    await expect(alert.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(page.locator(".pull-progress")).toHaveCount(0); // no stuck bar
    expect(await page.locator("body").innerText()).not.toMatch(/terminated/i);

    dropDownload = false;
    await alert.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("Local: qwen2.5:3b")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("alert").filter({ hasText: STOPPED })).toHaveCount(0);

    // Degraded: Ollama is unreachable (this test's Ollama URL is a dead port) while switching AWAY
    // from an Ollama brain → the best-effort unload fails quietly and the save still succeeds.
    const toOllama = await page.evaluate(() => window.skovern.brain.save({ provider: "local", key: "", model: "mistral:7b" }));
    expect(toOllama.ok).toBe(true);
    const back = await page.evaluate(() => window.skovern.brain.save({ provider: "local", key: "", model: "qwen2.5:3b" }));
    expect(back.ok).toBe(true);
    expect((await page.evaluate(() => window.skovern.brain.status())).model).toBe("qwen2.5:3b");
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

// Ledger `model-delete-active-catalog-edge` end to end (checker finding 4): the live model list
// RENAMES the active built-in (new id + new file) after it was downloaded. The brain's own stored
// filename still marks the old file "in use", and deleting it still clears the brain — through the
// real save → keychain → delete path, not just the pure function.
test("deleting the active brain clears it even after the model list renamed it", async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const app = await launch(userDataDir, { SKOVERN_OLLAMA_URL: "http://127.0.0.1:1", SKOVERN_OLLAMA_INSTALLED: "0", SKOVERN_LLAMA_FAKE: "1" });
  try {
    const page = await app.firstWindow();
    await signIn(page, "renamed@shop.test");
    await openLocalSetup(page);
    await page.getByRole("button", { name: "Get this one" }).first().click();
    await expect(page.getByText("Local: qwen2.5:3b")).toBeVisible({ timeout: 60_000 });

    remapCatalog = true;
    // Rescan until the new list is in (the catalog loader caches for 3 s, so the first may hit it).
    await expect(async () => {
      await page.getByRole("button", { name: "Check my computer again" }).click();
      await expect(page.getByText(REMAPPED.label).first()).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });

    await openYourBrain(page);
    const your = page.locator(".your-models");
    const row = your.locator("tr.receipt-row", { hasText: GGUF_FILENAME }); // no catalog label any more
    await expect(row.getByText("in use")).toBeVisible();
    await row.getByRole("button", { name: "Delete" }).click();
    await row.getByRole("button", { name: "Yes, delete" }).click();
    await expect(row).toHaveCount(0, { timeout: 15_000 });
    const status = await page.evaluate(() => window.skovern.brain.status());
    expect(status.configured).toBe(false); // no dangling pointer at the deleted file
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

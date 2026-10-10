import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { fit, specFor } from "@dawid-ai/model-fit";
import { AuthService, AuthStore, ConsoleMailer, startAuthServer, type RunningServer } from "@skovern/site";
import { speedWords } from "../src/renderer/src/pages/speed-words.js";

// Loop 046 — each brain on the local-brain screen shows how fast it'll write on THIS computer,
// from the shared @dawid-ai/model-fit math, and shows NO speed whenever acting on one would be a
// guess. Real Electron UI, real local server; every environment input is fixtured: hardware via
// SKOVERN_HARDWARE, the catalog via SKOVERN_CATALOG_URL (serving the SHIPPED catalog/models.json —
// the real composition), Ollama via a loopback fake with the user's own pulled models (one with
// no size or parameter count at all). PASS/FAIL never reads this machine's real hardware.

const GiB = 1024 ** 3;
const here = path.dirname(fileURLToPath(import.meta.url));
const SHIPPED_CATALOG = readFileSync(path.join(here, "..", "..", "..", "catalog", "models.json"), "utf8");
const CATALOG_MODELS = (JSON.parse(SHIPPED_CATALOG) as { models: { id: string; params: number; sizeBytes: number; quant: string }[] }).models;

type Hw = {
  ramBytes: number | null;
  cpuCores: number | null;
  gpus: { model: string; vramBytes: number | null; vendor?: string }[];
  bestVramBytes: number | null;
  unifiedMemory: boolean;
  diskFreeBytes: number | null;
  notes: string[];
};
const hw = (p: Partial<Hw>): Hw => ({ ramBytes: 64 * GiB, cpuCores: 16, gpus: [], bestVramBytes: null, unifiedMemory: false, diskFreeBytes: 500 * GiB, notes: [], ...p });
const XTX = hw({ gpus: [{ model: "AMD Radeon RX 7900 XTX", vramBytes: 24 * GiB, vendor: "AMD" }], bestVramBytes: 24 * GiB });
const UNKNOWN_GPU = hw({ gpus: [{ model: "Test GPU 24GB", vramBytes: 24 * GiB }], bestVramBytes: 24 * GiB });
const CPU_16 = hw({ ramBytes: 16 * GiB, cpuCores: 8 });
const NO_MEMORY = hw({ ramBytes: null, cpuCores: null });

// What the app should show for a shipped catalog model on a machine — computed from the SAME
// module, with the same options Skovern's verdict passes (4096 context, 66% of unified memory, a
// 2 GB iGPU floor).
function expectedWords(profile: Hw, id = "qwen2.5:3b"): string {
  const m = CATALOG_MODELS.find((c) => c.id === id)!;
  const spec = specFor(m.id)!;
  const r = fit(
    profile,
    { params: m.params, sizeBytes: m.sizeBytes, quant: m.quant, layers: spec.layers, kvHeads: spec.kvHeads, headDim: spec.headDim },
    { ctx: 4096, unifiedUsable: 0.66, minUsefulVramBytes: 2 * GiB },
  );
  return speedWords(r.tokPerSec)!;
}

let catalog: Server | null = null;
let ollama: Server | null = null;
function listen(s: Server, suffix = ""): Promise<string> {
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}${suffix}`)));
}

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let server: RunningServer;
let mailer: ConsoleMailer;
let catalogUrl: string;
let ollamaUrl: string;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  await new AuthStore(pool).migrate();
  mailer = new ConsoleMailer();
  server = await startAuthServer({ service: new AuthService(new AuthStore(pool), mailer, { appUrl: "https://app.test" }) });
  catalog = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(SHIPPED_CATALOG);
  });
  catalogUrl = await listen(catalog, "/catalog/models.json");
  ollama = createServer((req, res) => {
    const json = (b: unknown): void => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(b));
    };
    if (req.method === "GET" && req.url === "/api/tags") {
      return json({
        models: [
          // The user's own pulled models, NOT in the catalog: one with a size, one with nothing.
          { name: "mistral:7b", size: 4_700_000_000, details: { quantization_level: "Q4_K_M", parameter_size: "7B" } },
          { name: "mystery:latest" },
          // An embedding model: it never writes, so it must never show a words-per-second.
          { name: "nomic-embed-text:latest", size: 274_000_000, details: { quantization_level: "F16", parameter_size: "137M" } },
        ],
      });
    }
    if (req.method === "GET" && req.url === "/api/ps") return json({ models: [] });
    res.writeHead(404);
    res.end("{}");
  });
  ollamaUrl = await listen(ollama);
});

test.afterAll(async () => {
  await server?.close();
  await pool?.end();
  await container?.stop();
  catalog?.close();
  ollama?.close();
});

// Every receipt line recording a byte about to leave ("sent" phase), routine or not.
function egressLines(dir: string): string[] {
  let log = "";
  try {
    log = readFileSync(path.join(dir, "receipts.jsonl"), "utf8");
  } catch {
    return [];
  }
  return log.split("\n").filter((l) => l.includes('"phase":"sent"'));
}

async function openBrainTable(profile: Hw): Promise<{ app: ElectronApplication; page: Page; dir: string; egressBeforeOpen: string[] }> {
  const dir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const app = await electron.launch({
    args: [".", `--user-data-dir=${dir}`],
    env: {
      ...process.env,
      SKOVERN_API_URL: server.url,
      SKOVERN_CATALOG_URL: catalogUrl,
      SKOVERN_OLLAMA_URL: ollamaUrl,
      SKOVERN_OLLAMA_INSTALLED: "1",
      SKOVERN_HARDWARE: JSON.stringify(profile),
    },
  });
  const page = await app.firstWindow();
  const before = mailer.sent.length;
  await page.getByLabel("Your email").fill(`speed-${Date.now()}@shop.test`);
  await page.getByRole("button", { name: "Send me a link" }).click();
  await expect.poll(() => mailer.sent.length, { timeout: 30_000 }).toBeGreaterThan(before);
  await page.getByLabel("Paste your link").fill(mailer.sent[mailer.sent.length - 1]!.url);
  await page.getByRole("button", { name: "Verify" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const egressBeforeOpen = egressLines(dir);
  await page.getByLabel("Pick a brain").selectOption("local");
  await page.getByRole("button", { name: "Set up the local brain →" }).click();
  await expect(page.locator("tr.receipt-row", { hasText: "Qwen2.5 3B" }).first()).toBeVisible({ timeout: 30_000 });
  return { app, page, dir, egressBeforeOpen };
}

const row = (page: Page, text: string) => page.locator("table.local-table tr.receipt-row", { hasText: text }).first();

// E6: at 900×600 and 640×720 the label and speed stay inside their own cell and the page never
// scrolls sideways.
async function fitsAtSmallWindows(app: ElectronApplication, page: Page, r: ReturnType<typeof row>): Promise<void> {
  for (const [width, height] of [[900, 600], [640, 720]] as const) {
    await app.evaluate(async ({ BrowserWindow }, b) => BrowserWindow.getAllWindows()[0]?.setBounds(b), { width, height });
    // The resize really happened (a window that silently kept its size would pass everything below).
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(width);
    await r.locator(".local-speed").scrollIntoViewIfNeeded();
    const cell = await r.locator("td").nth(1).boundingBox();
    expect(cell).toBeTruthy();
    for (const part of [".local-fit", ".local-speed"]) {
      const box = await r.locator(part).boundingBox();
      expect(box, part).toBeTruthy();
      expect(box!.x, part).toBeGreaterThanOrEqual(cell!.x - 0.5);
      expect(box!.x + box!.width, part).toBeLessThanOrEqual(cell!.x + cell!.width + 0.5);
      expect(box!.y + box!.height, part).toBeLessThanOrEqual(cell!.y + cell!.height + 0.5);
    }
    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflowX, `${width}×${height}`).toBeLessThanOrEqual(0);
  }
}
test("E1 + E6: a named card shows the module's speed, in its cell, at short and narrow windows; no new egress", async () => {
  test.setTimeout(180_000);
  const { app, page, dir, egressBeforeOpen } = await openBrainTable(XTX);
  try {
    const r3 = row(page, "Qwen2.5 3B");
    await expect(r3).toContainText("Runs great here");
    await expect(r3.locator(".local-speed")).toHaveText(expectedWords(XTX)); // fast card → "faster than you can read"
    // A big model stays under the cap, so a real NUMBER from the named card's bandwidth is on screen.
    const words32 = expectedWords(XTX, "qwen2.5:32b");
    expect(words32).toMatch(/^Writes about \d+ words a second$/);
    await expect(row(page, "Qwen2.5 32B").locator(".local-speed")).toHaveText(words32);

    // No new egress: of EVERYTHING that left while opening the table, there is exactly the one
    // catalog fetch it always made, and anything else is a routine background poll (messages) —
    // nothing new, nothing user-visible. The speed math sends nothing.
    const newEgress = egressLines(dir).slice(egressBeforeOpen.length);
    expect(newEgress.filter((l) => l.includes('"task":"Skovern: model list"'))).toHaveLength(1);
    expect(newEgress.filter((l) => !l.includes('"task":"Skovern: model list"') && !l.includes('"routine":true'))).toEqual([]);

    await fitsAtSmallWindows(app, page, r3);

  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E2 + S5: an unknown card still shows a speed; a pulled model we know nothing about shows none", async () => {
  test.setTimeout(180_000);
  const { app, page, dir } = await openBrainTable(UNKNOWN_GPU);
  try {
    await expect(row(page, "Qwen2.5 3B").locator(".local-speed")).toHaveText(expectedWords(UNKNOWN_GPU));
    await expect(row(page, "mistral:7b").locator(".local-speed")).toHaveText(/^Writes about \d+ words a second$/);
    // S5: no size, no parameter count → a tier, but never a made-up speed (and never NaN/0).
    const mystery = row(page, "mystery:latest");
    await expect(mystery).toBeVisible();
    await expect(mystery.locator(".local-speed")).toHaveCount(0);
    // …and an embedding model never claims to write at all.
    const embed = row(page, "nomic-embed-text:latest");
    await expect(embed).toBeVisible();
    await expect(embed.locator(".local-speed")).toHaveCount(0);
    expect(await page.locator("body").innerText()).not.toMatch(/NaN|about 0 words/);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E3 + E5: CPU-only — small brains show a slower speed, red rows show none", async () => {
  test.setTimeout(180_000);
  const { app, page, dir } = await openBrainTable(CPU_16);
  try {
    const r3 = row(page, "Qwen2.5 3B");
    await expect(r3).toContainText("Runs, but slowly");
    await expect(r3.locator(".local-speed")).toHaveText(expectedWords(CPU_16));
    // F2 (Dawid, 2026-10-07): a small brain that's quick on the processor says where it runs, not "slowly".
    const tiny = row(page, "Qwen2.5 0.5B");
    await expect(tiny).toContainText("Runs on your processor");
    await expect(tiny).not.toContainText("slowly");
    await expect(tiny.locator(".local-speed")).toHaveText(expectedWords(CPU_16, "qwen2.5:0.5b"));
    await fitsAtSmallWindows(app, page, tiny); // G4: the longer amber label holds at small windows too
    // Above 7B on the processor is red ("painfully slow"), and the 32B doesn't fit at all: no speed.
    // Red is a warning, never a gate (Dawid, 2026-10-07): the row stays actionable, but says plainly
    // it won't run well here and shows no speed that could suggest otherwise.
    for (const text of ["Qwen2.5 14B", "Qwen2.5 32B"]) {
      const r = row(page, text);
      await expect(r).toContainText("Too big for this computer");
      await expect(r.locator(".fit-dot.fit-red")).toBeVisible();
      await expect(r.locator(".local-speed")).toHaveCount(0);
      await expect(r.getByRole("button", { name: /Get this one|Use this one|Needs Ollama/ })).toBeVisible(); // not a gate
    }
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E4: memory unknown — no speed anywhere, no invented number", async () => {
  test.setTimeout(180_000);
  const { app, page, dir } = await openBrainTable(NO_MEMORY);
  try {
    await expect(page.locator(".local-speed")).toHaveCount(0);
    expect(await page.locator("body").innerText()).not.toMatch(/words a second/);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

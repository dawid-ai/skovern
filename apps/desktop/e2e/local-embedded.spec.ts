import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { AuthService, AuthStore, ConsoleMailer, startAuthServer, type RunningServer } from "@deskhand/site";

// Loop 026 (2a) app-level metric: the NO-OLLAMA persona. Ollama is down, but an EMBEDDED
// model (Qwen2.5-3B, gguf) shows and is actionable. "Get this one" runs OUR streaming,
// sha256-gated downloader against a fixture server; "Use this one" runs a skill on the
// (faked) node-llama-cpp child → the Receipts page shows the Hugging Face download (In ↓)
// AND a "stayed on your computer" generate. The native runtime is faked (DESKHAND_LLAMA_FAKE)
// and the download bytes come from a loopback fixture (DESKHAND_MODEL_DOWNLOAD_URL), so
// PASS/FAIL is a pure function of the diff — the real 2 GB native run is hand-validation.

const FAKE_REPLY = "Hello — I'm your private brain, running right here on your computer.";
const GGUF_FILENAME = "qwen2.5-3b-instruct-q4_k_m.gguf";
// The bytes the fixture "download" serves; the catalog sha256 must match these.
const MODEL_BODY = Buffer.from("FAKE-GGUF-BYTES-for-the-embedded-runtime-e2e".repeat(50));
const MODEL_SHA256 = createHash("sha256").update(MODEL_BODY).digest("hex");

// A CPU-only machine so the verdict is deterministic on any runner; 16 GB → the 3B model
// is amber/usable and, as the only catalog model, the recommendation.
const CPU_HARDWARE = JSON.stringify({
  ramBytes: 16 * 1024 ** 3,
  cpuCores: 8,
  gpus: [],
  bestVramBytes: null,
  unifiedMemory: false,
  diskFreeBytes: 200 * 1024 ** 3,
  notes: [],
});

let catalog: Server | null = null;
let download: Server | null = null;

// The catalog gguf.url is a real https HF link (validator requires https; the receipt
// shows the real host). The actual bytes come from the download fixture via the seam.
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
              sizeBytes: MODEL_BODY.length,
              quant: "Q4_K_M",
              creator: "Alibaba (Qwen team)",
              homepage: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF",
              license: "Apache 2.0 — free to use.",
              licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
              tradeoff: "A strong little all-rounder that runs privately on your computer.",
              gguf: {
                url: `https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/${GGUF_FILENAME}`,
                sha256: MODEL_SHA256,
                sizeBytes: MODEL_BODY.length,
                filename: GGUF_FILENAME,
                contextSize: 4096,
              },
            },
          ],
        }),
      );
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

test("no-Ollama user downloads and runs an embedded private brain", async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "deskhand-e2e-"));
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      DESKHAND_API_URL: server.url,
      DESKHAND_OLLAMA_URL: "http://127.0.0.1:1", // nothing listening → Ollama is DOWN
      DESKHAND_CATALOG_URL: catalogUrl,
      DESKHAND_HARDWARE: CPU_HARDWARE,
      DESKHAND_LLAMA_FAKE: "1", // fake the native child (canned reply)
      DESKHAND_MODEL_DOWNLOAD_URL: downloadUrl, // stream the model bytes from the fixture
    },
  });

  try {
    const page = await app.firstWindow();

    // sign in
    await page.getByLabel("Your email").fill("nollama@shop.test");
    await page.getByRole("button", { name: "Send me a link" }).click();
    await expect.poll(() => mailer.sent.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.getByLabel("Paste your link").fill(mailer.sent[mailer.sent.length - 1]!.url);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText(/founding user #1/i)).toBeVisible();

    // Settings → local brain → its setup page
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Your brain").selectOption("local");
    await page.getByRole("button", { name: "Set up the local brain →" }).click();
    await expect(page.getByRole("heading", { name: "On this computer" })).toBeVisible();

    // DEGRADED (no-Ollama, but embedded exists): the table shows even though Ollama is
    // DOWN — and the embedded Qwen's action is a live "Get this one" (a real action,
    // NOT a dead/disabled button, and NOT a premature "Use this one").
    const table = page.locator("table.local-table");
    const qwenRow = table.locator("tr.receipt-row", { hasText: "Qwen2.5 3B" });
    await expect(qwenRow).toBeVisible({ timeout: 30_000 });
    const getBtn = qwenRow.getByRole("button", { name: "Get this one" });
    await expect(getBtn).toBeEnabled(); // real action available without Ollama, not a dead button

    // GET THIS ONE → our streaming + sha256-gated downloader (fixture bytes) → then it
    // becomes the active brain in one click.
    await getBtn.click();
    await expect(page.getByText("Local: qwen2.5:3b")).toBeVisible({ timeout: 30_000 });

    // the verified model file is on disk
    expect(existsSync(path.join(userDataDir, "models", GGUF_FILENAME))).toBe(true);

    // run a skill on the embedded brain (faked child) → the private reply shows
    await page.getByRole("button", { name: "← Back to Settings" }).click();
    await page.getByRole("button", { name: "Test my brain" }).click();
    await expect(page.getByText(FAKE_REPLY)).toBeVisible({ timeout: 30_000 });

    // RECEIPTS: the Hugging Face download tagged In ↓, AND the generate stayed on the
    // machine (no egress "sent" for it).
    await page.getByRole("button", { name: "Receipts" }).click();
    const dlRow = page.locator("tr.receipt-row", { hasText: "huggingface.co" });
    await expect(dlRow).toBeVisible({ timeout: 30_000 });
    await expect(dlRow.getByText("In ↓")).toBeVisible();
    await expect(page.getByText(/on your computer/).first()).toBeVisible();

    // on-disk proof: the download is a fetch receipt (huggingface host, direction in) and
    // the generate is a local:true on-machine call — the model reply never touched the log.
    const log = readFileSync(path.join(userDataDir, "receipts.jsonl"), "utf8");
    expect(log).toContain(`"task":"Downloading ${GGUF_FILENAME}"`);
    expect(log).toContain('"host":"huggingface.co"');
    expect(log).toContain('"direction":"in"');
    expect(log).toContain('"provider":"local"');
    expect(log).toContain('"local":true');
    expect(log).not.toContain(FAKE_REPLY);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

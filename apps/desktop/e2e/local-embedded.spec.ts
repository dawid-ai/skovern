import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { AuthService, AuthStore, ConsoleMailer, startAuthServer, type RunningServer } from "@skovern/site";

// Loop 026 (2a) app-level metric: the NO-OLLAMA persona. Ollama is down, but an EMBEDDED
// model (Qwen2.5-3B, gguf) shows and is actionable. "Get this one" runs OUR streaming,
// sha256-gated downloader against a fixture server; "Use this one" runs a skill on the
// (faked) node-llama-cpp child → the Receipts page shows the Hugging Face download (In ↓)
// AND a "stayed on your computer" generate. The native runtime is faked (SKOVERN_LLAMA_FAKE)
// and the download bytes come from a loopback fixture (SKOVERN_MODEL_DOWNLOAD_URL), so
// PASS/FAIL is a pure function of the diff — the real 2 GB native run is hand-validation.

const FAKE_REPLY = "Hello — I'm your private brain, running right here on your computer.";
const GGUF_FILENAME = "qwen2.5-3b-instruct-q4_k_m.gguf"; // the small embedded model
const GGUF_FILENAME_7B = "Qwen2.5-7B-Instruct-Q4_K_M.gguf"; // the bigger embedded model (download target)
// The bytes the fixture "download" serves; the catalog sha256 must match these.
const MODEL_BODY = Buffer.from("FAKE-GGUF-BYTES-for-the-embedded-runtime-e2e".repeat(50));
const MODEL_SHA256 = createHash("sha256").update(MODEL_BODY).digest("hex");

// A powerful 24 GB-GPU machine (pinned → deterministic on any runner). Loop 028: the 3B
// AND 7B are EMBEDDED (download+run here, no Ollama) and both run great, so the pick is
// the biggest fitting EMBEDDED one (7B) with a LIVE button; a 14B Ollama-only model is a
// great fit too but not gettable without Ollama, so it's demoted to "Advanced".
const GPU_HARDWARE = JSON.stringify({
  ramBytes: 64 * 1024 ** 3,
  cpuCores: 16,
  gpus: [{ model: "Test GPU 24GB", vramBytes: 24 * 1024 ** 3 }],
  bestVramBytes: 24 * 1024 ** 3,
  unifiedMemory: false,
  diskFreeBytes: 500 * 1024 ** 3,
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
            {
              // A BIGGER embedded model (has gguf) → runs here with no Ollama, and being
              // the biggest fitting embedded one it's the recommendation ("Our pick").
              id: "qwen2.5:7b",
              label: "Qwen2.5 7B",
              params: 7,
              sizeBytes: MODEL_BODY.length,
              quant: "Q4_K_M",
              creator: "Alibaba (Qwen team)",
              homepage: "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF",
              license: "Apache 2.0 — free to use.",
              licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
              tradeoff: "A big step up in smarts — runs privately right here on your GPU.",
              gguf: {
                url: `https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/${GGUF_FILENAME_7B}`,
                sha256: MODEL_SHA256,
                sizeBytes: MODEL_BODY.length,
                filename: GGUF_FILENAME_7B,
                contextSize: 4096,
              },
            },
            {
              // An Ollama-ONLY model (no gguf): a great fit on this GPU, but not gettable
              // without Ollama — demoted to "Advanced", its button honestly "Needs Ollama".
              id: "qwen2.5:14b",
              label: "Qwen2.5 14B",
              params: 14,
              sizeBytes: Math.round(9 * 1024 ** 3),
              quant: "Q4_K_M",
              creator: "Alibaba (Qwen team)",
              homepage: "https://huggingface.co/Qwen/Qwen2.5-14B-Instruct",
              license: "Apache 2.0 — free to use.",
              licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
              tradeoff: "Bigger and smarter, but needs the Ollama helper.",
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
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      SKOVERN_API_URL: server.url,
      SKOVERN_OLLAMA_URL: "http://127.0.0.1:1", // nothing listening → Ollama is DOWN
      SKOVERN_OLLAMA_INSTALLED: "0", // deterministic: Ollama not installed (Dawid's box has it) → no start-prompt
      SKOVERN_CATALOG_URL: catalogUrl,
      SKOVERN_HARDWARE: GPU_HARDWARE,
      SKOVERN_LLAMA_FAKE: "1", // fake the native child (canned reply)
      SKOVERN_MODEL_DOWNLOAD_URL: downloadUrl, // stream the model bytes from the fixture
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

    // EMBEDDED-FIRST (loop 028): the main "Runs right here" list holds the models that
    // download AND run with no Ollama (3B + 7B), each a LIVE "Get this one". Even with
    // Ollama DOWN, the pick is the biggest FITTING embedded model (7B) — a real button.
    const hereTable = page.locator(".local-group table.local-table");
    const row7b = hereTable.locator("tr.receipt-row", { hasText: "Qwen2.5 7B" });
    await expect(row7b).toBeVisible({ timeout: 30_000 });
    await expect(hereTable.locator("tr.receipt-row", { hasText: "Qwen2.5 3B" })).toBeVisible();
    await expect(row7b.locator(".local-status.status-pick")).toHaveText("Our pick"); // biggest embedded
    const getBtn = row7b.getByRole("button", { name: "Get this one" });
    await expect(getBtn).toBeEnabled(); // real action without Ollama, not a dead button

    // The Ollama-only 14B is NOT in the main list — it's demoted behind a collapsed
    // "Advanced — needs Ollama" section; expanding shows the honest disabled button.
    await expect(hereTable.locator("tr.receipt-row", { hasText: "Qwen2.5 14B" })).toHaveCount(0);
    const advanced = page.locator("details.local-advanced");
    await expect(advanced.locator("summary")).toContainText("Advanced");
    await advanced.locator("summary").click(); // expand it
    const row14b = advanced.locator("tr.receipt-row", { hasText: "Qwen2.5 14B" });
    await expect(row14b).toBeVisible();
    await expect(row14b.getByRole("button", { name: "Needs Ollama" })).toBeDisabled();

    // GET THIS ONE (the 7B, our pick) → streaming + sha256-gated downloader (fixture bytes)
    // → becomes the active brain in one click. Proves a BIGGER embedded model downloads.
    await getBtn.click();
    await expect(page.getByText("Local: qwen2.5:7b")).toBeVisible({ timeout: 30_000 });
    expect(existsSync(path.join(userDataDir, "models", GGUF_FILENAME_7B))).toBe(true);

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
    expect(log).toContain(`"task":"Downloading ${GGUF_FILENAME_7B}"`);
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

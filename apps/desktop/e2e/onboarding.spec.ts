import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { AuthService, AuthStore, ConsoleMailer, startAuthServer, type RunningServer } from "@skovern/site";

// Loop 032 metric: self-reliant local brain. A signed-in user with NO brain is guided into a
// first-run ONBOARDING that sets up the built-in, on-computer brain with zero external tools
// (O1). And when the configured brain is a local Ollama model that's unreachable, chat AND
// "Test my brain" both fall back to the downloaded built-in one (O2 — generalized from the
// chat-only stopgap). Native runtime + download are fixtured, so PASS/FAIL is a pure function
// of the diff; the real streamed inference stays hand-validation.

const FAKE_REPLY = "Hello — I'm your private brain, running right here on your computer.";
const GGUF_FILENAME = "qwen2.5-3b-instruct-q4_k_m.gguf";
const MODEL_BODY = Buffer.from("FAKE-GGUF-BYTES-for-the-onboarding-e2e".repeat(50));
const MODEL_SHA256 = createHash("sha256").update(MODEL_BODY).digest("hex");

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

// Sign in but DON'T assert the shell — a no-brain user sees Onboarding, not the shell.
async function signIn(page: Page, email: string): Promise<void> {
  const before = mailer.sent.length;
  await page.getByLabel("Your email").fill(email);
  await page.getByRole("button", { name: "Send me a link" }).click();
  await expect.poll(() => mailer.sent.length, { timeout: 30_000 }).toBeGreaterThan(before);
  await page.getByLabel("Paste your link").fill(mailer.sent[mailer.sent.length - 1]!.url);
  await page.getByRole("button", { name: "Verify" }).click();
}

function launchOpts(userDataDir: string) {
  return {
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      SKOVERN_API_URL: server.url,
      SKOVERN_OLLAMA_URL: "http://127.0.0.1:1", // Ollama down → embedded path
      SKOVERN_CATALOG_URL: catalogUrl,
      SKOVERN_HARDWARE: GPU_HARDWARE,
      SKOVERN_LLAMA_FAKE: "1",
      SKOVERN_LLAMA_FAKE_DELAY_MS: "150",
      SKOVERN_MODEL_DOWNLOAD_URL: downloadUrl,
    },
  };
}

// Drive the first-run banner → onboarding → built-in brain setup (shared by O1 and O2).
async function setUpBuiltInBrain(page: Page): Promise<void> {
  // A no-brain user sees the shell WITH a non-blocking first-run banner (the app stays usable).
  await expect(page.getByText(/Set up your brain to get started/i)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Set it up →" }).click();
  await expect(page.getByRole("heading", { name: "Let's set up your brain." })).toBeVisible();
  await page.getByRole("button", { name: "Set up my private brain →" }).click();
  await expect(page.getByRole("heading", { name: "On this computer" })).toBeVisible();
  // download + activate the built-in embedded model (fixture bytes) — no Ollama involved
  await page.getByRole("button", { name: "Get this one" }).first().click();
  await expect(page.getByText("Local: qwen2.5:3b")).toBeVisible({ timeout: 60_000 });
}

test("O1: a first-run user is onboarded to a working built-in brain, then chats", async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const app = await electron.launch(launchOpts(userDataDir));
  try {
    const page = await app.firstWindow();
    await signIn(page, "onboard@shop.test");
    await setUpBuiltInBrain(page);

    // once a brain is active, the app proper is reachable and chat works with zero external tools
    await page.getByRole("button", { name: "Chat" }).click();
    await page.getByRole("button", { name: "New chat" }).click();
    await page.getByLabel("Message your brain").fill("hello");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator(".chat-thread .from-brain p").last()).toHaveText(FAKE_REPLY, { timeout: 30_000 });
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("O2: an unreachable Ollama brain falls back to the built-in in BOTH chat and Test my brain", async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const receiptsPath = path.join(userDataDir, "receipts.jsonl");
  const app = await electron.launch(launchOpts(userDataDir));
  try {
    const page = await app.firstWindow();
    await signIn(page, "fallback@shop.test");
    // First get a built-in model DOWNLOADED (via onboarding), so there's something to fall back to.
    await setUpBuiltInBrain(page);

    // Now pin the brain to an OLLAMA model (not embedded). Ollama is down (dead port), so every
    // local call must fall back to the downloaded built-in. Set it directly via the IPC — the
    // Ollama-model config can't be produced in CI through the UI (needs a live Ollama).
    await page.evaluate(() => window.skovern.brain.save({ provider: "local", key: "", model: "mistral-small:latest" }));

    // chat falls back to the built-in, with the honest note
    await page.getByRole("button", { name: "Chat" }).click();
    await page.getByRole("button", { name: "New chat" }).click();
    await page.getByLabel("Message your brain").fill("are you there?");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator(".chat-thread .from-brain p").last()).toHaveText(FAKE_REPLY, { timeout: 30_000 });
    await expect(page.locator(".chat-fallback-note")).toContainText(/built-in one/i);

    // the fallback call is still receipted as on-machine (one receipt, local:true — egress
    // guarantee preserved on the swapped path)
    const log = readFileSync(receiptsPath, "utf8");
    expect(log).toContain('"provider":"local"');
    expect(log).toContain('"local":true');

    // "Test my brain" also falls back, and says so in its result
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Test my brain" }).click();
    await expect(page.getByText(FAKE_REPLY)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/built-in one/i)).toBeVisible();
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("O3: Ollama consent — the auto-launch preference persists, and a down Ollama still answers", async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...launchOpts(userDataDir).env,
      SKOVERN_OLLAMA_INSTALLED: "1", // Ollama "installed" (seam) but the URL is dead → not running
      SKOVERN_OLLAMA_SPAWN_FAKE: "1", // a fake `ollama serve` (records the attempt, won't serve)
    },
  });
  try {
    const page = await app.firstWindow();
    await signIn(page, "ollama@shop.test");
    await setUpBuiltInBrain(page); // a downloaded built-in exists to fall back to

    // Settings shows the Ollama CONSENT OFFER (default 'ask' + installed) — we ask before ever
    // starting Ollama for the user.
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByText("Ollama (optional helper)")).toBeVisible();
    await expect(page.getByText(/We found Ollama on your computer/i)).toBeVisible();
    await page.getByRole("button", { name: "Yes, start it automatically" }).click();
    // the choice persists across navigation (the offer is gone, the setting reads "always")
    await page.getByRole("button", { name: "What's new" }).click();
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByLabel(/If you pick an Ollama brain/i)).toHaveValue("always");

    // Pin the brain to an Ollama model. With "always" + installed + down, the app ATTEMPTS a
    // (fake) launch; the fake can't serve, so it gracefully falls back to the built-in.
    await page.evaluate(() => window.skovern.brain.save({ provider: "local", key: "", model: "mistral-small:latest" }));
    await page.getByRole("button", { name: "Chat" }).click();
    await page.getByRole("button", { name: "New chat" }).click();
    await page.getByLabel("Message your brain").fill("hi");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator(".chat-thread .from-brain p").last()).toHaveText(FAKE_REPLY, { timeout: 30_000 });
    await expect(page.locator(".chat-fallback-note")).toContainText(/built-in one/i);

    // prove the consent→launch WIRING fired (not just a silent built-in shortcut): "always" +
    // installed + down actually attempted the (fake) `ollama serve`.
    const attempts = await page.evaluate(() => window.skovern.settings.ollamaStatus().then((s) => s.launchAttempts ?? 0));
    expect(attempts).toBeGreaterThan(0);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("Issue 3a: 'use my built-in brain' with NO model downloaded routes to setup, not a silent no-op", async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...launchOpts(userDataDir).env,
      SKOVERN_OLLAMA_INSTALLED: "1", // installed (seam) so the consent offer appears; URL is dead → not running
    },
  });
  try {
    const page = await app.firstWindow();
    await signIn(page, "builtin-route@shop.test");
    // No brain, and NO embedded model on disk (we never download one here).
    await expect(page.getByText(/Set up your brain to get started/i)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Settings" }).click();
    // The Ollama consent offer shows (installed + default 'ask').
    await expect(page.getByText(/We found Ollama on your computer/i)).toBeVisible();
    // Choosing the built-in when there's nothing on disk must ROUTE to the download/setup flow —
    // the loop-032 bug was that it silently set a pref and did nothing (Issue 3).
    await page.getByRole("button", { name: "No, use my built-in brain" }).click();
    await expect(page.getByRole("heading", { name: "On this computer", exact: true })).toBeVisible({ timeout: 15_000 });
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("O4: onboarding always offers an escape to an online brain — never a dead end", async () => {
  test.setTimeout(120_000);
  // No embedded fixtures here: even if the built-in couldn't be set up, onboarding must never
  // trap the user — the online-brain escape is always offered and reaches the usable app.
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: { ...process.env, SKOVERN_API_URL: server.url },
  });
  try {
    const page = await app.firstWindow();
    await signIn(page, "online@shop.test");
    await expect(page.getByText(/Set up your brain to get started/i)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Set it up →" }).click();
    await expect(page.getByRole("heading", { name: "Let's set up your brain." })).toBeVisible();
    // choose the online escape → land in the usable app, not a dead end
    await page.getByRole("button", { name: "I'd rather use an online brain" }).click();
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByLabel("Your brain")).toBeVisible(); // the online-brain picker is reachable
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

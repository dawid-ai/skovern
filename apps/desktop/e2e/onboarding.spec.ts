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
      SKOVERN_OLLAMA_INSTALLED: "0", // deterministic default: not installed → no start-prompt (O3/Issue3a override to "1")
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
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByRole("button", { name: "New chat" }).click();
    await page.getByLabel("Message your brain").fill("hello");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator(".chat-thread .from-brain p").last()).toHaveText(FAKE_REPLY, { timeout: 30_000 });
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("Issue 5: after onboarding sets up a brain, the app lands in Chat — not What's new", async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const app = await electron.launch(launchOpts(userDataDir));
  try {
    const page = await app.firstWindow();
    await signIn(page, "land@shop.test");
    await setUpBuiltInBrain(page); // download + activate → onConfigured fires
    // E6: we're on the CHAT page now (its heading + "New chat" + the no-chat empty state), NOT
    // dumped on "What's new".
    await expect(page.getByRole("heading", { name: "Chat", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
    await expect(page.getByText("Start a new chat to begin.")).toBeVisible();
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("Issue 1: the onboarding brain-setup is inside a scroll container — the bottom isn't clipped", async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const app = await electron.launch(launchOpts(userDataDir));
  try {
    const page = await app.firstWindow();
    // a short window so the tall setup content MUST scroll, not clip off the bottom
    await app.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ width: 900, height: 520 }));
    await signIn(page, "clip@shop.test");
    // enter onboarding via the first-run banner, then the private-brain setup
    await page.getByRole("button", { name: "Set it up →" }).click();
    await page.getByRole("button", { name: "Set up my private brain →" }).click();
    await expect(page.getByRole("heading", { name: "On this computer" })).toBeVisible({ timeout: 30_000 });

    // The regression: onboarding rendered the setup with NO scroll container, so it clipped.
    // The fix wraps it in `.content` (overflow-y: auto). Assert the wrapper exists AND the
    // bottom is reachable by scrolling (not cut off the window).
    const s = await page.evaluate(() => {
      const c = document.querySelector(".content") as HTMLElement | null;
      const wrapsPage = !!c?.querySelector(".page");
      const overflowY = c ? getComputedStyle(c).overflowY : "";
      if (c) c.scrollTop = c.scrollHeight; // try to reach the bottom
      const bottomReachable = !c ? false : c.scrollHeight <= c.clientHeight || c.scrollTop > 0;
      return { hasWrapper: !!c && wrapsPage, overflowY, bottomReachable };
    });
    expect(s.hasWrapper).toBe(true); // the setup is inside a scroll container
    expect(s.overflowY).toBe("auto");
    expect(s.bottomReachable).toBe(true); // nothing clipped past the window
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
    await page.getByRole("button", { name: "Chat", exact: true }).click();
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
    await page.getByRole("button", { name: "Chat", exact: true }).click();
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

// ── Loop 037 — guided onboarding: ONE stable built-in pick, and the word "Ollama" never
// appears on the guided screen. The recommendation scores our built-in (gguf) catalog only,
// so it can't lurch when a background Ollama starts. Every environment input (hardware, catalog,
// Ollama reachability) is fixtured, so PASS/FAIL is a pure function of the diff.
test.describe("loop 037 — guided onboarding: one stable built-in pick, no Ollama", () => {
  const HASH = "a".repeat(64); // well-formed sha (models are inspected, never downloaded here)
  const gguf = (filename: string, sizeBytes: number) => ({
    url: `https://huggingface.co/x/resolve/main/${filename}`,
    sha256: HASH,
    sizeBytes,
    filename,
    contextSize: 4096,
  });
  const built = (id: string, label: string, params: number, sizeBytes: number, filename: string) => ({
    id, label, params, sizeBytes, quant: "Q4_K_M",
    creator: "Alibaba (Qwen team)", homepage: "https://huggingface.co/x",
    license: "Apache 2.0 — free to use.", licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
    tradeoff: "A private brain that runs right here.", gguf: gguf(filename, sizeBytes),
  });
  // Fixture-realism: our built-in 3/7/14B (gguf) PLUS a bigger Ollama-only catalog entry (no
  // gguf) — the exact composition that used to flip the pick when Ollama woke.
  const CATALOG_037 = {
    models: [
      built("qwen2.5:3b", "Qwen2.5 3B", 3, 2_000_000_000, "qwen2.5-3b.gguf"),
      built("qwen2.5:7b", "Qwen2.5 7B", 7, 4_700_000_000, "qwen2.5-7b.gguf"),
      built("qwen2.5:14b", "Qwen2.5 14B", 14, 9_000_000_000, "qwen2.5-14b.gguf"),
      { id: "gemma2:27b", label: "Gemma2 27B (Ollama)", params: 27, sizeBytes: 16_000_000_000,
        quant: "Q4_K_M", creator: "Google", homepage: "https://huggingface.co/x",
        license: "Gemma license.", licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
        tradeoff: "A big one." },
    ],
  };
  const GPU_24 = JSON.stringify({
    ramBytes: 64 * 1024 ** 3, cpuCores: 16,
    gpus: [{ model: "Test GPU 24GB", vramBytes: 24 * 1024 ** 3 }],
    bestVramBytes: 24 * 1024 ** 3, unifiedMemory: false, diskFreeBytes: 500 * 1024 ** 3, notes: [],
  });
  const WEAK = JSON.stringify({
    ramBytes: 2 * 1024 ** 3, cpuCores: 2, gpus: [], bestVramBytes: null,
    unifiedMemory: false, diskFreeBytes: 60 * 1024 ** 3, notes: [],
  });

  let cat: Server | null = null;
  let ollamaUp: Server | null = null;
  let catUrl = "";
  let ollamaUpUrl = "";

  test.beforeAll(async () => {
    catUrl = await new Promise<string>((resolve) => {
      cat = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(CATALOG_037));
      });
      cat.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(cat!.address() as AddressInfo).port}/catalog/models.json`));
    });
    // Ollama UP, serving a pulled 22B NOT in the catalog — green on 24 GB and bigger than the top
    // built-in, i.e. exactly what USED to steal the recommendation once Ollama came up.
    ollamaUpUrl = await new Promise<string>((resolve) => {
      ollamaUp = createServer((req, res) => {
        if ((req.url ?? "") === "/api/tags") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ models: [{ name: "codestral:22b", size: 13_000_000_000, details: { quantization_level: "Q4_K_M", parameter_size: "22B" } }] }));
          return;
        }
        res.writeHead(404);
        res.end("{}");
      });
      ollamaUp.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(ollamaUp!.address() as AddressInfo).port}`));
    });
  });

  test.afterAll(() => {
    cat?.close();
    ollamaUp?.close();
  });

  function env037(over: Record<string, string>) {
    return {
      ...process.env,
      SKOVERN_API_URL: server.url,
      SKOVERN_CATALOG_URL: catUrl,
      SKOVERN_HARDWARE: GPU_24,
      SKOVERN_OLLAMA_INSTALLED: "0",
      SKOVERN_OLLAMA_URL: "http://127.0.0.1:1", // down by default
      ...over,
    };
  }

  // Sign in and walk to the guided "On this computer" screen; wait for the scan to resolve.
  async function toGuided(page: Page, email: string): Promise<void> {
    await signIn(page, email);
    await expect(page.getByText(/Set up your brain to get started/i)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Set it up →" }).click();
    await page.getByRole("button", { name: "Set up my private brain →" }).click();
    await expect(page.getByRole("heading", { name: "On this computer" })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".local-verdict")).toBeVisible({ timeout: 30_000 }); // scan resolved
  }

  const heroLabel = (page: Page) => page.locator(".local-callouts .callout h3").first().innerText();

  test("E1: exactly ONE recommended pick, with its size and a get action", async () => {
    test.setTimeout(120_000);
    const dir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
    const app = await electron.launch({ args: [".", `--user-data-dir=${dir}`], env: env037({}) });
    try {
      const page = await app.firstWindow();
      await toGuided(page, "b-one@shop.test");
      await expect(page.locator(".local-callouts .callout")).toHaveCount(1);
      const hero = page.locator(".local-callouts .callout").first();
      await expect(hero.getByText(/Our pick for your computer/i)).toBeVisible();
      await expect(hero.locator(".callout-action button")).toBeVisible(); // actionable get
      await expect(hero).toContainText(/GB/); // its size is shown
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("E2: the pick is IDENTICAL with Ollama down vs up-with-a-bigger-pulled-model (the flip case)", async () => {
    test.setTimeout(180_000);
    const d1 = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
    const a1 = await electron.launch({ args: [".", `--user-data-dir=${d1}`], env: env037({}) });
    let downPick = "";
    try {
      const p = await a1.firstWindow();
      await toGuided(p, "b-down@shop.test");
      downPick = (await heroLabel(p)).trim();
    } finally {
      await a1.close();
      rmSync(d1, { recursive: true, force: true });
    }

    const d2 = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
    const a2 = await electron.launch({ args: [".", `--user-data-dir=${d2}`], env: env037({ SKOVERN_OLLAMA_INSTALLED: "1", SKOVERN_OLLAMA_URL: ollamaUpUrl }) });
    let upPick = "";
    try {
      const p = await a2.firstWindow();
      await toGuided(p, "b-up@shop.test");
      upPick = (await heroLabel(p)).trim();
    } finally {
      await a2.close();
      rmSync(d2, { recursive: true, force: true });
    }

    expect(downPick).toBe("Qwen2.5 14B"); // biggest built-in that runs great on 24 GB
    expect(upPick).toBe(downPick); // no flip — a background Ollama can't move the pick
  });

  test("E3: the word 'Ollama' never appears on the guided screen (even with Ollama up)", async () => {
    test.setTimeout(120_000);
    const dir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
    const app = await electron.launch({ args: [".", `--user-data-dir=${dir}`], env: env037({ SKOVERN_OLLAMA_INSTALLED: "1", SKOVERN_OLLAMA_URL: ollamaUpUrl }) });
    try {
      const page = await app.firstWindow();
      await toGuided(page, "b-noword@shop.test");
      const more = page.locator("details.local-other-options > summary");
      if (await more.count()) await more.click(); // include the revealed content in the check
      const text = await page.locator(".page").innerText();
      expect(text.toLowerCase()).not.toContain("ollama");
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("E4: 'see other options' is a collapsed reveal of the OTHER built-ins, honestly fit-labelled", async () => {
    test.setTimeout(120_000);
    const dir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
    const app = await electron.launch({ args: [".", `--user-data-dir=${dir}`], env: env037({}) });
    try {
      const page = await app.firstWindow();
      await toGuided(page, "b-more@shop.test");
      const details = page.locator("details.local-other-options");
      await expect(details).toBeVisible();
      expect(await details.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false); // collapsed → hero is the focus
      await details.locator("summary").click();
      await expect(details.getByText("Qwen2.5 7B")).toBeVisible(); // an other built-in
      await expect(details.getByText(/Runs great here|Runs, but slowly|Too big for this computer/).first()).toBeVisible();
      await expect(details.getByText("Qwen2.5 14B")).toHaveCount(0); // the hero isn't duplicated
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("E5: the headline and the hero name the SAME model (single source of truth)", async () => {
    test.setTimeout(120_000);
    const dir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
    const app = await electron.launch({ args: [".", `--user-data-dir=${dir}`], env: env037({}) });
    try {
      const page = await app.firstWindow();
      await toGuided(page, "b-sot@shop.test");
      const hero = (await heroLabel(page)).trim();
      const headline = await page.locator(".local-headline").innerText();
      expect(headline).toContain(hero); // headline names the same model as the hero
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("E6: weak hardware — honest guidance and NO dead 'download' hero", async () => {
    test.setTimeout(120_000);
    const dir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
    const app = await electron.launch({ args: [".", `--user-data-dir=${dir}`], env: env037({ SKOVERN_HARDWARE: WEAK }) });
    try {
      const page = await app.firstWindow();
      await toGuided(page, "b-weak@shop.test");
      await expect(page.locator(".local-callouts")).toHaveCount(0); // no recommended hero at all
      await expect(page.getByText(/No private brain runs well on this computer/i)).toBeVisible();
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

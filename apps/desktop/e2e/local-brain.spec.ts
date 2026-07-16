import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { AuthService, AuthStore, ConsoleMailer, startAuthServer, type RunningServer } from "@skovern/site";

// Loop 019 metric E1 (app-level, real Electron UI): sign in → Settings → "On this
// computer" → the honest verdict + "what you have" / "our suggestions" (trade-offs,
// download state, best highlighted) render against a FAKE Ollama + FAKE catalog
// (no real Ollama/GitHub in CI) → pick an already-downloaded model → run a real
// call on it → the Receipts page shows a "stayed on your computer" entry (no egress)
// AND a github catalog receipt. Also: a descriptive error when Ollama is unreachable.
//
// Loop 022 adds, on the same flow (deterministic — the fixture emits fixed token
// counts): the local run's receipt shows TOKENS not bytes; a no-token local call
// falls back to the plain honest line; the routine catalog poll is GROUPED (write-time
// `routine` flag) not a table row; and opening the local view fires ONE catalog fetch,
// so exactly one "model list" receipt exists per open (was two).

const LOCAL_REPLY = "Hello from your private local brain.";

// A fixed CPU-only machine so the verdict is deterministic on ANY runner (CI is
// CPU-only; a dev box may have a big GPU). With 16 GB RAM and no usable GPU:
// mistral:7b + qwen2.5:3b are amber (usable), qwen2.5:235b is red — so the pulled
// mistral:7b is always the biggest-usable recommendation. Fed via the SKOVERN_HARDWARE
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
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          let model = "";
          try {
            model = (JSON.parse(raw) as { model?: string }).model ?? "";
          } catch {
            /* keep model "" */
          }
          res.writeHead(200, { "content-type": "application/json" });
          // mistral:7b reports token usage (prompt_eval_count/eval_count); a bare-reply
          // model (qwen2.5:3b) does NOT — so the panel shows tokens for one and the plain
          // "stayed on your computer" line for the other (the degraded no-token path).
          res.end(
            model === "mistral:7b"
              ? JSON.stringify({ response: LOCAL_REPLY, prompt_eval_count: 7, eval_count: 42 })
              : JSON.stringify({ response: LOCAL_REPLY }),
          );
        });
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

// A strong-GPU machine (24 GB) so bigger models fit — the profile Dawid actually has.
const GPU_HARDWARE = JSON.stringify({
  ramBytes: 64 * 1024 ** 3,
  cpuCores: 16,
  gpus: [{ model: "Test GPU 24GB", vramBytes: 24 * 1024 ** 3 }],
  bestVramBytes: 24 * 1024 ** 3,
  unifiedMemory: false,
  diskFreeBytes: 500 * 1024 ** 3,
  notes: [],
});

// Loop 035 — Ollama installed but not running: a real loading state (E1), a consented "Start
// Ollama" that reveals the user's OWN pulled models (E3/E4), and pull-any-model-by-name (E5).
test("Ollama installed-but-down: honest loading, consented Start reveals your pulled models, pull any by name", async () => {
  test.setTimeout(180_000);
  let ollamaUp = false; // the test flips this UP to simulate a successful start
  const pulls: string[] = []; // model names the fixture was asked to pull

  // A controllable Ollama: 503 ("down") until `ollamaUp`, then the user's OWN pulled models.
  const toggle = createServer((req, res) => {
    const url = req.url ?? "";
    if (!ollamaUp) {
      res.writeHead(503);
      res.end("{}");
      return;
    }
    if (req.method === "GET" && url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          models: [
            { name: "gemma2:9b", size: 5_400_000_000, details: { quantization_level: "Q4_K_M", parameter_size: "9B" } },
            { name: "mixtral:8x7b", size: 26_000_000_000, details: { quantization_level: "Q4_K_M", parameter_size: "47B" } },
          ],
        }),
      );
      return;
    }
    if (req.method === "POST" && url === "/api/pull") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          const b = JSON.parse(raw) as { model?: string; name?: string };
          pulls.push(b.model ?? b.name ?? "");
        } catch {
          /* ignore */
        }
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(JSON.stringify({ status: "pulling", completed: 5e7, total: 1e8 }) + "\n");
        res.end(JSON.stringify({ status: "success" }) + "\n");
      });
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((r) => toggle.listen(0, "127.0.0.1", () => r()));
  const toggleUrl = `http://127.0.0.1:${(toggle.address() as AddressInfo).port}`;

  // A DELAYED catalog so the LOADING state (E1) is observable before the scan resolves.
  const slowCat = createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          models: [{ id: "qwen2.5:3b", label: "Qwen2.5 3B", params: 3, sizeBytes: 2e9, quant: "Q4_K_M", creator: "Alibaba (Qwen team)", homepage: "https://huggingface.co/x", license: "Apache 2.0 — free.", licenseUrl: "https://apache.org/x", tradeoff: "good" }],
        }),
      );
    }, 700);
  });
  await new Promise<void>((r) => slowCat.listen(0, "127.0.0.1", () => r()));
  const slowCatUrl = `http://127.0.0.1:${(slowCat.address() as AddressInfo).port}/catalog/models.json`;

  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      SKOVERN_API_URL: server.url,
      SKOVERN_OLLAMA_INSTALLED: "1", // installed…
      SKOVERN_OLLAMA_URL: toggleUrl, // …but 503 (down) until we flip it
      SKOVERN_OLLAMA_SPAWN_FAKE: "serve", // "start" succeeds once the fixture is up
      SKOVERN_CATALOG_URL: slowCatUrl,
      SKOVERN_HARDWARE: GPU_HARDWARE,
    },
  });
  try {
    const page = await app.firstWindow();
    const before = mailer.sent.length;
    await page.getByLabel("Your email").fill("gpu@shop.test");
    await page.getByRole("button", { name: "Send me a link" }).click();
    await expect.poll(() => mailer.sent.length, { timeout: 30_000 }).toBeGreaterThan(before);
    await page.getByLabel("Paste your link").fill(mailer.sent[mailer.sent.length - 1]!.url);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText(/founding user #/i)).toBeVisible();

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Your brain").selectOption("local");
    await page.getByRole("button", { name: "Set up the local brain →" }).click();

    // E1: while the (slow) scan runs, a REAL structured loading state shows — a spinner, not bare text.
    await expect(page.locator(".local-loading .spinner")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("heading", { name: "On this computer" })).toBeVisible({ timeout: 30_000 });

    // E3: Ollama installed but DOWN → an actionable "Start Ollama" prompt, and the user's
    // models are NOT shown yet (they can't be enumerated while it's down).
    const startBtn = page.getByRole("button", { name: "Start Ollama to see your models" });
    await expect(startBtn).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("mixtral:8x7b")).toHaveCount(0);

    // E4: consent to start → bring Ollama up (simulated) + click → the user's OWN pulled
    // models (gemma/mixtral, NOT in the catalog) appear as ready; the start prompt is gone.
    ollamaUp = true;
    await startBtn.click();
    const table = page.locator("table.local-table");
    await expect(table.locator("tr.receipt-row", { hasText: "mixtral:8x7b" })).toBeVisible({ timeout: 30_000 });
    await expect(table.locator("tr.receipt-row", { hasText: "gemma2:9b" })).toBeVisible();
    await expect(startBtn).toHaveCount(0);

    // E5: pull ANY Ollama model by name (Advanced). A malformed name is rejected BEFORE any
    // pull; a valid one pulls and becomes the active brain.
    await page.locator("details.local-advanced summary").click();
    const nameInput = page.getByLabel("Ollama model name");
    await nameInput.fill("bad name!");
    await page.getByRole("button", { name: "Get it" }).click();
    await expect(page.getByText(/Use only letters/i)).toBeVisible({ timeout: 10_000 });
    expect(pulls).not.toContain("bad name!"); // rejected before any /api/pull

    await nameInput.fill("codellama:13b");
    await page.getByRole("button", { name: "Get it" }).click();
    await expect(page.getByText("Local: codellama:13b")).toBeVisible({ timeout: 30_000 });
    expect(pulls).toContain("codellama:13b"); // the pull actually fired
  } finally {
    await app.close();
    toggle.close();
    slowCat.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("user sets up a private on-computer brain, always sees which brain is active, and runs it", async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      SKOVERN_API_URL: server.url,
      SKOVERN_OLLAMA_URL: ollamaUrl,
      SKOVERN_CATALOG_URL: catalogUrl,
      SKOVERN_HARDWARE: CPU_HARDWARE,
      // Ollama NOT installed (deterministic): so the degraded case below shows the honest
      // "isn't running" line, not the loop-035 "Start Ollama" prompt (which needs it installed).
      SKOVERN_OLLAMA_INSTALLED: "0",
    },
  });

  try {
    const page = await app.firstWindow();

    // sign in (capture the before-count — another test in this file signs in too, so a bare
    // ">0" would grab a stale link)
    const before = mailer.sent.length;
    await page.getByLabel("Your email").fill("local@shop.test");
    await page.getByRole("button", { name: "Send me a link" }).click();
    await expect.poll(() => mailer.sent.length, { timeout: 30_000 }).toBeGreaterThan(before);
    await page.getByLabel("Paste your link").fill(mailer.sent[mailer.sent.length - 1]!.url);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText(/founding user #/i)).toBeVisible(); // order-independent (another test may take #1)

    // the always-visible active-brain readout starts empty for a fresh user
    await expect(page.getByText("No brain yet")).toBeVisible();

    // Settings → pick the local brain → open its dedicated setup view
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Your brain").selectOption("local");
    await page.getByRole("button", { name: "Set up the local brain →" }).click();

    // the honest verdict + a hardware line render
    await expect(page.getByRole("heading", { name: "On this computer" })).toBeVisible();
    await expect(page.getByText(/private brain|cloud brain|subscription/i).first()).toBeVisible({ timeout: 30_000 });

    // CONSISTENCY (regression for the 019 contradiction): the verdict headline names the
    // SAME model as the "Our pick" callout. The user's own mistral:7b outranks the catalog
    // picks, so it's the recommendation. Asserted wording-independently (headline copy
    // differs green vs amber, but the MODEL it names must match the pick callout).
    const pickCallout = page.locator(".callout-pick");
    await expect(pickCallout.getByText("Our pick for your computer")).toBeVisible({ timeout: 30_000 });
    await expect(pickCallout.getByRole("heading", { name: "mistral:7b" })).toBeVisible();
    await expect(page.locator(".local-headline")).toContainText("mistral:7b");
    // no brain picked yet → no "This is your brain" callout dangling
    await expect(page.locator(".callout-brain")).toHaveCount(0);

    // NEW LAYOUT — EVERY model is in ONE table, nothing behind a fold: the always-red
    // Qwen2.5 235B (previously hidden under "Other options") is visible immediately, and
    // there is no "Other options" disclosure at all.
    await expect(page.getByText("Other options")).toHaveCount(0);
    const table = page.locator("table.local-table");
    await expect(table.locator("tr.receipt-row", { hasText: "mistral:7b" })).toBeVisible();
    await expect(table.locator("tr.receipt-row", { hasText: "Qwen2.5 3B" })).toBeVisible();
    await expect(table.locator("tr.receipt-row", { hasText: "Qwen2.5 235B" })).toBeVisible();
    // the recommended row is marked "Our pick" in the table; transparency is present
    await expect(table.locator("tr.receipt-row", { hasText: "mistral:7b" }).getByText("Our pick", { exact: true })).toBeVisible();
    await expect(page.getByText(/by Alibaba/).first()).toBeVisible();

    // DOUBLE-FETCH FIXED (closes local-catalog-double-fetch): first + only open so far;
    // both IPC calls share the cached catalog → exactly ONE "model list" sent receipt.
    const afterOpen = readFileSync(path.join(userDataDir, "receipts.jsonl"), "utf8");
    const modelListSent = afterOpen
      .split("\n")
      .filter((l) => l.includes('"task":"Skovern: model list"') && l.includes('"phase":"sent"'));
    expect(modelListSent).toHaveLength(1);

    // DOWNLOAD-AND-USE from the table: "Get this one" on Qwen2.5 3B (NOT the recommended
    // model) pulls AND selects it → the active brain is now DIFFERENT from the recommended.
    await table.locator("tr.receipt-row", { hasText: "Qwen2.5 3B" }).getByRole("button", { name: "Get this one" }).click();
    await expect(page.getByText("Local: qwen2.5:3b")).toBeVisible({ timeout: 30_000 });

    // THE FIX (this loop): active ≠ recommended → BOTH callouts are obvious with NO clicking.
    // "This is your brain" names the active qwen (shown by its catalog label "Qwen2.5 3B");
    // "Our pick" still names mistral.
    await expect(page.locator(".callout-brain")).toContainText("This is your brain");
    await expect(page.locator(".callout-brain")).toContainText("Qwen2.5 3B");
    await expect(page.locator(".callout-pick")).toContainText("Our pick for your computer");
    await expect(page.locator(".callout-pick")).toContainText("mistral:7b");
    // the table marks the active one "Your brain ✓" and the recommended one "Our pick"
    // (exact: the status span, not the disabled "This is your brain ✓" action button).
    await expect(table.locator("tr.receipt-row", { hasText: "Qwen2.5 3B" }).getByText("Your brain ✓", { exact: true })).toBeVisible();
    await expect(table.locator("tr.receipt-row", { hasText: "mistral:7b" }).getByText("Our pick", { exact: true })).toBeVisible();

    // run a call on the ACTIVE qwen brain — it reports NO token counts in the fixture, so
    // the receipt falls back to the plain "stayed on your computer" line (022 degraded path).
    await page.getByRole("button", { name: "← Back to Settings" }).click();
    await page.getByRole("button", { name: "Test my brain" }).click();
    await expect(page.getByText(LOCAL_REPLY)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Receipts" }).click();
    await expect(page.getByText("stayed on your computer — nothing left").first()).toBeVisible({ timeout: 30_000 });

    // switch to the recommended mistral from the table → active == recommended → ONE
    // combined callout (no confusing duplicate), and the sidebar flips.
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Set up the local brain →" }).click();
    await table.locator("tr.receipt-row", { hasText: "mistral:7b" }).getByRole("button", { name: "Use this one" }).click();
    await expect(page.getByText("Local: mistral:7b")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Your brain — our pick, too")).toBeVisible();
    await expect(page.locator(".callout-pick")).toHaveCount(0); // no separate pick card when they're the same

    // back to Settings: the "right now you're using" line names the active provider+model
    await page.getByRole("button", { name: "← Back to Settings" }).click();
    await expect(page.locator(".active-brain")).toContainText("On this computer");
    await expect(page.locator(".active-brain")).toContainText("mistral:7b");

    // run a real call on the mistral brain (reports tokens)
    await page.getByRole("button", { name: "Test my brain" }).click();
    await expect(page.getByText(LOCAL_REPLY)).toBeVisible({ timeout: 30_000 });

    // Receipts page (loop 022): the local mistral run shows the TOKENS it used ("all
    // on your computer"), NOT bytes; and the routine catalog poll is GROUPED under
    // "Routine background checks", never a row in the main table.
    await page.getByRole("button", { name: "Receipts" }).click();
    await expect(page.getByText(/7 tokens in, 42 out/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/all on your computer/).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Routine background checks" })).toBeVisible();
    await expect(page.getByText("Checked the model list").first()).toBeVisible();

    // on-disk proof: a local:true model receipt WITH token counts (never bytes for the
    // local reply), the catalog poll tagged routine:true at the source, and the reply
    // body never touched the log.
    const log = readFileSync(path.join(userDataDir, "receipts.jsonl"), "utf8");
    expect(log).toContain('"provider":"local"');
    expect(log).toContain('"local":true');
    expect(log).toContain('"tokensIn":7');
    expect(log).toContain('"tokensOut":42');
    const modelListLine = log.split("\n").find((l) => l.includes('"task":"Skovern: model list"'));
    expect(modelListLine).toContain('"routine":true');
    expect(log).not.toContain(LOCAL_REPLY);

    // IN-USE MARKER ON LOAD: reopening the local setup shows the active mistral as in use
    // (the combined "your brain — our pick" callout, since active == recommended) WITHOUT
    // clicking anything.
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Set up the local brain →" }).click();
    await expect(page.getByText("Your brain — our pick, too")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "This is your brain ✓" }).first()).toBeVisible();

    // DEGRADED — Ollama unreachable: stop the fake server, reopen → plain-language "isn't
    // running", and NO callouts/table (nothing actionable dangles — the 020 no-dead-pick rule).
    await new Promise<void>((resolve) => (ollama ? ollama.close(() => resolve()) : resolve()));
    ollama = null;
    await page.getByRole("button", { name: "← Back to Settings" }).click();
    await page.getByRole("button", { name: "Set up the local brain →" }).click();
    await expect(page.getByText(/Ollama isn't running/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".callout-pick")).toHaveCount(0);
    await expect(page.locator(".callout-brain")).toHaveCount(0);
    await expect(page.locator("table.local-table")).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { AuthService, AuthStore, ConsoleMailer, startAuthServer, type RunningServer } from "@skovern/site";

// Loop 031 (Chat feature, Loop B) app-level metric: the REAL Electron UI + real server.
// A LOCAL embedded brain (faked native child, fixture download bytes) streams a reply
// into the Chat page token-by-token, chats persist across a relaunch, Stop keeps the
// partial, new/rename/delete work, titles auto-derive, and exactly one on-machine
// receipt pair is written per message. Two smaller tests cover the no-brain degraded
// state (C6) and the cloud-honesty note (C7). Everything is fixtured through
// !app.isPackaged seams, so PASS/FAIL is a pure function of the diff.

const FAKE_REPLY = "Hello — I'm your private brain, running right here on your computer.";
const FAKE_KEY = "sk-fake-test-key-should-never-be-logged";
const GGUF_FILENAME = "qwen2.5-3b-instruct-q4_k_m.gguf";
const MODEL_BODY = Buffer.from("FAKE-GGUF-BYTES-for-the-chat-e2e".repeat(50));
const MODEL_SHA256 = createHash("sha256").update(MODEL_BODY).digest("hex");

// A GPU box (pinned → deterministic on any runner) so the 3B embedded model fits + is
// the recommended "Get this one".
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

// A tiny OpenAI-compatible endpoint for the CLOUD-honesty test (C7). The real
// openRouterProvider posts to `${baseURL}/chat/completions`; we answer normally.
let brain: Server | null = null;
function startMockBrain(): Promise<string> {
  return new Promise((resolve) => {
    brain = createServer((req, res) => {
      if (req.method === "POST" && (req.url ?? "").endsWith("/chat/completions")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-mock",
            object: "chat.completion",
            created: 0,
            model: "mock-model",
            choices: [{ index: 0, message: { role: "assistant", content: "hi from the cloud" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    brain.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(brain!.address() as AddressInfo).port}`));
  });
}

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let server: RunningServer;
let mailer: ConsoleMailer;
let catalogUrl: string;
let downloadUrl: string;
let brainUrl: string;

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
  brainUrl = await startMockBrain();
});

test.afterAll(async () => {
  await server?.close();
  await pool?.end();
  await container?.stop();
  catalog?.close();
  download?.close();
  brain?.close();
});

async function signIn(page: Page, email: string): Promise<void> {
  // The mailer is shared across the tests in this file, so wait for THIS request's email
  // (length INCREASES) — not just "non-empty", which would grab a prior test's stale link.
  const before = mailer.sent.length;
  await page.getByLabel("Your email").fill(email);
  await page.getByRole("button", { name: "Send me a link" }).click();
  await expect.poll(() => mailer.sent.length, { timeout: 30_000 }).toBeGreaterThan(before);
  await page.getByLabel("Paste your link").fill(mailer.sent[mailer.sent.length - 1]!.url);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText(/founding user #/i)).toBeVisible();
}

// The chat thread's brain-reply text, most recent last.
const lastBrainP = (page: Page) => page.locator(".chat-thread .from-brain p").last();

// Live scroll geometry of the thread — the loop-034 auto-follow + jump-nav proofs read this.
const threadMetrics = (page: Page) =>
  page.locator(".chat-thread").evaluate((el) => ({ top: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight }));
const isAtBottom = (m: { top: number; sh: number; ch: number }): boolean => m.top + m.ch >= m.sh - 8;

// Set up + activate the local EMBEDDED brain via the real UI (download the fixture 3B → active).
async function setupLocalEmbeddedBrain(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Your brain").selectOption("local");
  await page.getByRole("button", { name: "Set up the local brain →" }).click();
  await expect(page.getByRole("heading", { name: "On this computer" })).toBeVisible();
  await page.getByRole("button", { name: "Get this one" }).first().click();
  await expect(page.getByText("Local: qwen2.5:3b")).toBeVisible({ timeout: 60_000 });
}

// Seed a long (overflowing) chat on disk so scrolling actually matters.
function seedLongChat(chatsDir: string, id: string, title: string, turns: number): void {
  mkdirSync(chatsDir, { recursive: true });
  writeFileSync(
    path.join(chatsDir, "index.json"),
    JSON.stringify([{ id, title, createdAt: "2026-07-14T08:00:00.000Z", updatedAt: "2026-07-14T08:00:00.000Z" }]),
  );
  const lines: string[] = [];
  for (let i = 0; i < turns; i++) {
    lines.push(JSON.stringify({ role: "user", content: `question ${i} ${"x".repeat(50)}`, ts: `2026-07-14T08:00:${String(i % 60).padStart(2, "0")}.000Z` }));
    lines.push(JSON.stringify({ role: "assistant", content: `answer ${i} ${"y".repeat(50)}`, ts: `2026-07-14T08:10:${String(i % 60).padStart(2, "0")}.000Z` }));
  }
  writeFileSync(path.join(chatsDir, `${id}.jsonl`), lines.join("\n") + "\n");
}

test("chat streams a local reply, persists it, stops mid-stream, and writes one receipt", async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const receiptsPath = path.join(userDataDir, "receipts.jsonl");
  const chatsDir = path.join(userDataDir, "chats");

  // Fixture realism (retro-1): the receipts log already holds routine-poll noise AND a
  // prior (cloud) message pair, so "exactly one receipt per chat message" (C8) is proven
  // amid real composition, not a pristine log.
  writeFileSync(
    receiptsPath,
    [
      { kind: "fetch", host: "127.0.0.1", task: "Skovern: messages", direction: "in", routine: true, ts: "2026-07-14T09:00:00.000Z", bytesSent: 0, bytesReceived: 0, ok: true, phase: "done" },
      { kind: "fetch", host: "127.0.0.1", task: "Skovern: news", direction: "in", routine: true, ts: "2026-07-14T09:00:05.000Z", bytesSent: 0, bytesReceived: 0, ok: true, phase: "done" },
      { provider: "openrouter", model: "x", task: "Test my brain", bytesSent: 10, ts: "2026-07-14T09:01:00.000Z", bytesReceived: 0, ok: false, phase: "sent" },
      { provider: "openrouter", model: "x", task: "Test my brain", bytesSent: 10, ts: "2026-07-14T09:01:01.000Z", bytesReceived: 20, ok: true, phase: "done" },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n",
  );
  // A pre-existing chat, so list ordering (newest-first) is proven amid existing chats.
  mkdirSync(chatsDir, { recursive: true });
  writeFileSync(
    path.join(chatsDir, "index.json"),
    JSON.stringify([{ id: "seed-older-chat", title: "An older chat", createdAt: "2026-07-14T08:00:00.000Z", updatedAt: "2026-07-14T08:00:00.000Z" }]),
  );
  writeFileSync(
    path.join(chatsDir, "seed-older-chat.jsonl"),
    JSON.stringify({ role: "user", content: "old question", ts: "2026-07-14T08:00:01.000Z" }) + "\n" +
      JSON.stringify({ role: "assistant", content: "old answer", ts: "2026-07-14T08:00:02.000Z" }) + "\n",
  );

  const launchOpts = {
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      SKOVERN_API_URL: server.url,
      SKOVERN_OLLAMA_URL: "http://127.0.0.1:1", // Ollama down → embedded path
      SKOVERN_CATALOG_URL: catalogUrl,
      SKOVERN_HARDWARE: GPU_HARDWARE,
      SKOVERN_LLAMA_FAKE: "1", // fake native child, streams the canned reply
      SKOVERN_LLAMA_FAKE_DELAY_MS: "200", // slow enough to observe a mid-stream partial
      SKOVERN_MODEL_DOWNLOAD_URL: downloadUrl, // fixture model bytes
    },
  };

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch(launchOpts);
    let page = await app.firstWindow();
    await signIn(page, "chat@shop.test");

    // Set up a LOCAL embedded brain: Settings → local → download the 3B (fixture) → active.
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Your brain").selectOption("local");
    await page.getByRole("button", { name: "Set up the local brain →" }).click();
    await expect(page.getByRole("heading", { name: "On this computer" })).toBeVisible();
    // "Get this one" appears both in the recommendation callout and the table row — either
    // downloads the same 3B pick; take the first.
    await page.getByRole("button", { name: "Get this one" }).first().click();
    await expect(page.getByText("Local: qwen2.5:3b")).toBeVisible({ timeout: 60_000 });

    // ── C1: streamed reply renders incrementally ──────────────────────────────────────
    await page.getByRole("button", { name: "Chat" }).click();
    await page.getByRole("button", { name: "New chat" }).click();
    await page.getByLabel("Message your brain").fill("hello brain");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    // a mid-stream partial is visible BEFORE the final text (proves Loop A's stream reaches
    // the screen — not one whole-reply drop)
    await expect(lastBrainP(page)).toContainText("Hello", { timeout: 15_000 });
    const partial = (await lastBrainP(page).innerText()).trim();
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(FAKE_REPLY.length);
    // …then the whole reply assembles
    await expect(lastBrainP(page)).toHaveText(FAKE_REPLY, { timeout: 30_000 });
    // C5: the title auto-derived from the first user message
    await expect(page.locator(".chat-list").getByRole("button", { name: "hello brain" })).toBeVisible();

    // ── C8: exactly ONE on-machine receipt pair for that message, amid the noise ───────
    const lines = readFileSync(receiptsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const localModel = lines.filter((r) => r["provider"] === "local");
    expect(localModel.filter((r) => r["phase"] === "sent")).toHaveLength(1);
    expect(localModel.filter((r) => r["phase"] === "done")).toHaveLength(1);
    expect(localModel.every((r) => r["local"] === true)).toBe(true); // on-machine, no egress
    expect(readFileSync(receiptsPath, "utf8")).not.toContain(FAKE_REPLY); // reply never logged

    // C7 (negative): a LOCAL brain shows NO "leaves your computer" note.
    await expect(page.getByText(/leaves your computer/i)).toHaveCount(0);

    // ── C3: Stop mid-stream keeps the partial and re-enables the composer ──────────────
    await page.getByRole("button", { name: "New chat" }).click();
    await page.getByLabel("Message your brain").fill("stop me please");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(lastBrainP(page)).toContainText("Hello", { timeout: 15_000 }); // mid-stream
    await page.getByRole("button", { name: "Stop" }).click();
    // composer re-enables (Send is back)
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible({ timeout: 15_000 });
    // the partial reply was KEPT (not discarded) and is strictly shorter than the full reply
    const kept = (await lastBrainP(page).innerText()).trim();
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(FAKE_REPLY.length);

    // ── C4: new / rename / delete ─────────────────────────────────────────────────────
    await page.getByRole("button", { name: "New chat" }).click();
    await page.getByLabel("Message your brain").fill("chat to delete");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator(".chat-list").getByRole("button", { name: "chat to delete" })).toBeVisible({ timeout: 30_000 });
    // rename it → the title updates in the list
    await page.getByRole("button", { name: "Rename" }).click();
    await page.getByLabel("New name").fill("renamed chat");
    await page.getByRole("button", { name: "Save name" }).click();
    await expect(page.locator(".chat-list").getByRole("button", { name: "renamed chat" })).toBeVisible();
    // delete it → gone from the list AND its <id>.jsonl removed from disk
    const before = readdirSync(chatsDir).filter((f) => f.endsWith(".jsonl")).length;
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.locator(".chat-list").getByRole("button", { name: "renamed chat" })).toHaveCount(0);
    const after = readdirSync(chatsDir).filter((f) => f.endsWith(".jsonl")).length;
    expect(after).toBe(before - 1);

    // the pre-existing chat is still listed (ordering realism)
    await expect(page.locator(".chat-list").getByRole("button", { name: "An older chat" })).toBeVisible();

    await app.close();
    app = null;

    // ── C2: the chat + its messages survive a relaunch ────────────────────────────────
    app = await electron.launch(launchOpts);
    page = await app.firstWindow();
    await expect(page.getByText(/founding user #/i)).toBeVisible(); // session persisted
    await page.getByRole("button", { name: "Chat" }).click();
    await page.locator(".chat-list").getByRole("button", { name: "hello brain" }).click();
    await expect(page.locator(".chat-thread .from-you p")).toContainText("hello brain");
    await expect(page.locator(".chat-thread .from-brain p")).toContainText("private brain");
  } finally {
    await app?.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

// Loop 033 Issue 2 (streaming) + Issue 4 (prepare status) + Issue 3b (no-builtin → offer setup).
// The reply is a distinct string so the mid-stream partial assertion is unambiguous.
const OLLAMA_REPLY = "Hello from Ollama streaming one token at a time now.";

// A fake Ollama that STREAMS /api/generate as NDJSON (stream:true), one object per token
// with a gap between them — the real thing Issue 2 was missing. The first chunk is delayed
// so the "Thinking…" prepare status (Issue 4) is observable before any token lands.
function startStreamingOllama(): { server: Server; ready: Promise<string> } {
  let resolveUrl!: (u: string) => void;
  const ready = new Promise<string>((r) => (resolveUrl = r));
  const srv = createServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "mistral:7b", size: 4_700_000_000, details: { parameter_size: "7B", quantization_level: "Q4_K_M" } }] }));
      return;
    }
    if (req.method === "POST" && url === "/api/generate") {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        const words = OLLAMA_REPLY.split(" ");
        let i = 0;
        const step = (): void => {
          if (res.writableEnded) return;
          if (i >= words.length) {
            res.write(JSON.stringify({ response: "", done: true, prompt_eval_count: 8, eval_count: words.length }) + "\n");
            res.end();
            return;
          }
          res.write(JSON.stringify({ response: (i === 0 ? "" : " ") + words[i], done: false }) + "\n");
          i++;
          setTimeout(step, 120);
        };
        setTimeout(step, 600); // first token delayed → the "Thinking…" prepare status is observable
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  srv.listen(0, "127.0.0.1", () => resolveUrl(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`));
  return { server: srv, ready };
}

test("Issue 2/4/3b: an Ollama brain STREAMS token-by-token with a prepare status; when it goes down, Chat offers setup", async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const ollama = startStreamingOllama();
  const ollamaUrl = await ollama.ready;

  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      SKOVERN_API_URL: server.url,
      SKOVERN_OLLAMA_URL: ollamaUrl, // a REAL (fixture) Ollama, up and streaming
      SKOVERN_CATALOG_URL: catalogUrl, // no embedded model downloaded → no built-in fallback
      SKOVERN_HARDWARE: GPU_HARDWARE, // mistral:7b is usable → "Use this one"
    },
  });
  try {
    const page = await app.firstWindow();
    await signIn(page, "ollama-stream@shop.test");

    // Activate the pulled Ollama brain (mistral:7b, an Ollama-only id → routes to the Ollama engine).
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Your brain").selectOption("local");
    await page.getByRole("button", { name: "Set up the local brain →" }).click();
    await expect(page.getByRole("heading", { name: "On this computer" })).toBeVisible();
    await page.locator("tr.receipt-row", { hasText: "mistral:7b" }).getByRole("button", { name: "Use this one" }).click();
    await expect(page.getByText("Local: mistral:7b")).toBeVisible({ timeout: 30_000 });

    // ── Issue 4: a prepare status shows BEFORE the first token ──────────────────────────
    await page.getByRole("button", { name: "Chat" }).click();
    await page.getByRole("button", { name: "New chat" }).click();
    await page.getByLabel("Message your brain").fill("hello ollama");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    // the "Thinking…" prepare status is visible during the 600ms before the first token
    await expect(page.locator(".chat-status")).toBeVisible({ timeout: 5_000 });

    // ── Issue 2: the reply renders INCREMENTALLY (mid-stream partial before the full text) ─
    await expect(lastBrainP(page)).toContainText("Hello", { timeout: 15_000 });
    const partial = (await lastBrainP(page).innerText()).trim();
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(OLLAMA_REPLY.length); // NOT one whole-reply lump
    await expect(lastBrainP(page)).toHaveText(OLLAMA_REPLY, { timeout: 30_000 });

    // exactly one on-machine receipt pair for the streamed Ollama message
    const receiptsPath = path.join(userDataDir, "receipts.jsonl");
    const lines = readFileSync(receiptsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const localModel = lines.filter((r) => r["provider"] === "local");
    expect(localModel.filter((r) => r["phase"] === "sent")).toHaveLength(1);
    expect(localModel.filter((r) => r["phase"] === "done")).toHaveLength(1);
    expect(localModel.every((r) => r["local"] === true)).toBe(true);
    expect(readFileSync(receiptsPath, "utf8")).not.toContain(OLLAMA_REPLY);

    // ── Issue 3b: Ollama goes DOWN and there's no built-in on disk → Chat offers setup ──
    ollama.server.closeAllConnections?.();
    await new Promise<void>((r) => ollama.server.close(() => r()));
    await page.getByRole("button", { name: "New chat" }).click();
    await page.getByLabel("Message your brain").fill("are you still there?");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    // an honest error AND an actionable in-chat way out (not a dead end)
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Set up a brain →" })).toBeVisible();
  } finally {
    ollama.server.closeAllConnections?.();
    ollama.server.close();
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("Issue 1 (C6): with NO brain, Chat offers a 'Set up a brain' CTA into onboarding — no dead disabled box", async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: { ...process.env, SKOVERN_API_URL: server.url },
  });
  try {
    const page = await app.firstWindow();
    await signIn(page, "nobrain@shop.test");
    // E3 (loop 034): with no brain, the sidebar chip honestly reads "No brain yet".
    await expect(page.locator(".brain-chip")).toContainText("No brain yet");
    await page.getByRole("button", { name: "Chat" }).click();
    await page.getByRole("button", { name: "New chat" }).click();
    // still no dead Send (the composer is disabled without a brain)…
    await expect(page.getByLabel("Message your brain")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    // …but now there's an actionable way out from within Chat itself (Issue 1)
    const cta = page.getByRole("button", { name: "Set up a brain →" });
    await expect(cta).toBeVisible();
    await cta.click();
    // it lands on the onboarding setup, not a dead end
    await expect(page.getByRole("heading", { name: /set up your (private )?brain/i })).toBeVisible({ timeout: 15_000 });
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("C7: with a CLOUD brain, the chat shows an honest 'leaves your computer' note", async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: { ...process.env, SKOVERN_API_URL: server.url, SKOVERN_OPENROUTER_BASE_URL: brainUrl },
  });
  try {
    const page = await app.firstWindow();
    await signIn(page, "cloud@shop.test");
    // configure a cloud (OpenRouter) brain
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Your key").fill(FAKE_KEY);
    await page.getByRole("button", { name: "Save brain" }).click();
    await expect(page.getByText("Brain saved.")).toBeVisible();
    // the Chat page carries the honest note
    await page.getByRole("button", { name: "Chat" }).click();
    await expect(page.getByText(/leaves your computer/i)).toBeVisible();
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("a brain that FAILS surfaces an error in the chat, never silence", async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    // a cloud brain pointed at a dead port → every send fails fast (ECONNREFUSED). The bug
    // was: a failed send showed NOTHING. It must now show an honest error + re-enable send.
    env: { ...process.env, SKOVERN_API_URL: server.url, SKOVERN_OPENROUTER_BASE_URL: "http://127.0.0.1:1" },
  });
  try {
    const page = await app.firstWindow();
    await signIn(page, "fail@shop.test");
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Your key").fill(FAKE_KEY);
    await page.getByRole("button", { name: "Save brain" }).click();
    await expect(page.getByText("Brain saved.")).toBeVisible();

    await page.getByRole("button", { name: "Chat" }).click();
    await page.getByRole("button", { name: "New chat" }).click();
    await page.getByLabel("Message your brain").fill("are you there?");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    // the failure is visible (an alert), not swallowed into a blank chat
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("alert")).toContainText(/didn't answer|nothing|went wrong/i);
    // and the composer is usable again for a retry
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

// ── Loop 034: chat scroll + jump nav (no brain needed — a seeded long chat) ──────────────
// E10 open-at-bottom · E11 the four jump buttons · E12 disabled at the ends / empty thread.
test("chat scroll: opens at the bottom, the jump buttons navigate, and they disable at the ends", async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  seedLongChat(path.join(userDataDir, "chats"), "long-chat", "Long chat", 40);
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: { ...process.env, SKOVERN_API_URL: server.url },
  });
  try {
    const page = await app.firstWindow();
    // A SHORT window so the thread is squeezed — this is the regression condition Dawid hit:
    // the wrapper must let the thread SCROLL, not grow to fit content and spill over the composer.
    await app.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ width: 900, height: 520 }));
    await signIn(page, "scroll-nav@shop.test");
    await page.getByRole("button", { name: "Chat" }).click();
    await page.locator(".chat-list").getByRole("button", { name: "Long chat" }).click();

    // precondition: the thread overflows (there's something to scroll)
    await expect.poll(async () => { const m = await threadMetrics(page); return m.sh - m.ch; }).toBeGreaterThan(20);

    // Regression guard (loop-034 wrapper): the thread is a real scroll container and its content
    // does NOT overlap the composer — the reply text can't render over the text field.
    const overlap = await page.evaluate(() => {
      const thread = document.querySelector(".chat-thread");
      const composer = document.querySelector(".chat-composer");
      if (!thread || !composer) return { bad: true, reason: "missing" as const };
      const t = thread.getBoundingClientRect();
      const c = composer.getBoundingClientRect();
      return { bad: t.bottom > c.top + 1, threadBottom: t.bottom, composerTop: c.top };
    });
    expect(overlap.bad).toBe(false); // thread ends at or above the composer — no overlap

    // Back to a normal height for the nav assertions: at 520px even the one-line empty-chat
    // hint can scroll, which would (correctly) enable "Jump to top" — not the E12 case we mean.
    await app.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ width: 900, height: 820 }));

    // E10: an opened chat starts scrolled to the bottom (newest message in view)
    await expect.poll(async () => isAtBottom(await threadMetrics(page))).toBe(true);
    // at the bottom, "next reply" / "jump to newest" have nowhere to go → disabled
    await expect(page.getByRole("button", { name: "Jump to newest" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Next reply" })).toBeDisabled();

    // E11: Jump to top → scrollTop ~0; the top button then disables, prev disables
    await page.getByRole("button", { name: "Jump to top" }).click();
    await expect.poll(async () => (await threadMetrics(page)).top).toBeLessThanOrEqual(8);
    await expect(page.getByRole("button", { name: "Jump to top" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Previous reply" })).toBeDisabled();

    // E11: Next reply steps DOWN onto a reply; Jump to newest returns to the bottom
    await page.getByRole("button", { name: "Next reply" }).click();
    await expect.poll(async () => (await threadMetrics(page)).top).toBeGreaterThan(8);
    await page.getByRole("button", { name: "Jump to newest" }).click();
    await expect.poll(async () => isAtBottom(await threadMetrics(page))).toBe(true);
    // Previous reply from the bottom steps back UP
    const bottomTop = (await threadMetrics(page)).top;
    await page.getByRole("button", { name: "Previous reply" }).click();
    await expect.poll(async () => (await threadMetrics(page)).top).toBeLessThan(bottomTop);

    // E12: a fresh EMPTY chat → every jump button is disabled (nothing to navigate)
    await page.getByRole("button", { name: "New chat" }).click();
    await expect(page.getByRole("button", { name: "Jump to top" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Jump to newest" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Previous reply" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Next reply" })).toBeDisabled();
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

// ── Markdown: the brain's reply renders bold / lists / links / HR; the user's text stays literal ──
test("chat renders the brain's reply as safe markdown, and keeps the user's message literal", async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const chatsDir = path.join(userDataDir, "chats");
  mkdirSync(chatsDir, { recursive: true });
  writeFileSync(
    path.join(chatsDir, "index.json"),
    JSON.stringify([{ id: "md-chat", title: "Markdown chat", createdAt: "2026-07-14T08:00:00.000Z", updatedAt: "2026-07-14T08:00:00.000Z" }]),
  );
  const assistantMd = [
    "Here is **bold text** and a [link](https://example.com).",
    "",
    "- first point",
    "- second point",
    "",
    "---",
    "",
    "> a quote",
    "",
    "And a raw tag that must NOT become live: <script>alert(1)</script>",
  ].join("\n");
  writeFileSync(
    path.join(chatsDir, "md-chat.jsonl"),
    JSON.stringify({ role: "user", content: "show me **stars** literally", ts: "2026-07-14T08:00:01.000Z" }) + "\n" +
      JSON.stringify({ role: "assistant", content: assistantMd, ts: "2026-07-14T08:00:02.000Z" }) + "\n",
  );

  const app = await electron.launch({ args: [".", `--user-data-dir=${userDataDir}`], env: { ...process.env, SKOVERN_API_URL: server.url } });
  try {
    const page = await app.firstWindow();
    await signIn(page, "markdown@shop.test");
    await page.getByRole("button", { name: "Chat" }).click();
    await page.locator(".chat-list").getByRole("button", { name: "Markdown chat" }).click();

    const brain = page.locator(".chat-thread .from-brain");
    await expect(brain.locator("strong")).toHaveText("bold text"); // **bold** → <strong>
    await expect(brain.locator("a")).toHaveAttribute("href", "https://example.com"); // [link] → <a href>
    await expect(brain.locator("li")).toHaveCount(2); // bullet list → two <li>
    await expect(brain.locator("hr")).toHaveCount(1); // --- → <hr>
    await expect(brain.locator("blockquote")).toHaveCount(1); // > quote → <blockquote>
    // SECURITY: raw HTML in model output is NOT parsed into live elements (no rehype-raw).
    await expect(brain.locator("script")).toHaveCount(0);
    await expect(brain).toContainText("<script>alert(1)</script>"); // shown as literal text

    // The USER's own message is literal — "**stars**" is NOT turned into bold.
    const you = page.locator(".chat-thread .from-you");
    await expect(you.locator("strong")).toHaveCount(0);
    await expect(you).toContainText("**stars**");
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

// ── Loop 034: auto-follow while streaming + the brain chip (green/hide/receipts) ─────────
// E7 follow · E8 pause when scrolled up · E9 re-pin · E1 chip green when loaded · E5 hide to
// tray keeps the model loaded (the 66bc60c regression) · E6 the chip poll writes no receipts.
test("chat auto-follows the stream (pausing when scrolled up) and the chip stays green across a hide-to-tray", async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const receiptsPath = path.join(userDataDir, "receipts.jsonl");
  seedLongChat(path.join(userDataDir, "chats"), "long-chat", "Long chat", 40);
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      SKOVERN_API_URL: server.url,
      SKOVERN_OLLAMA_URL: "http://127.0.0.1:1", // Ollama down → embedded path
      SKOVERN_CATALOG_URL: catalogUrl,
      SKOVERN_HARDWARE: GPU_HARDWARE,
      SKOVERN_LLAMA_FAKE: "1",
      SKOVERN_LLAMA_FAKE_DELAY_MS: "250", // ~2.5s stream — room to interact
      SKOVERN_MODEL_DOWNLOAD_URL: downloadUrl,
      SKOVERN_IDLE_UNLOAD_MS: "120000", // large: the model must NOT idle-unload during this test
    },
  });
  try {
    const page = await app.firstWindow();
    await signIn(page, "follow@shop.test");
    await setupLocalEmbeddedBrain(page);
    await page.getByRole("button", { name: "Chat" }).click();
    await page.locator(".chat-list").getByRole("button", { name: "Long chat" }).click();
    await expect.poll(async () => isAtBottom(await threadMetrics(page))).toBe(true);

    // E7: pinned at the bottom → sending + streaming keeps the newest content in view
    await page.getByLabel("Message your brain").fill("follow me");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(lastBrainP(page)).toHaveText(FAKE_REPLY, { timeout: 30_000 });
    await expect.poll(async () => isAtBottom(await threadMetrics(page))).toBe(true);

    // E8: scroll UP → auto-follow pauses; the next send does NOT yank the view to the bottom
    await page.locator(".chat-thread").evaluate((el) => (el.scrollTop = 0));
    await page.waitForTimeout(250); // let the scroll handler mark us un-pinned
    await page.getByLabel("Message your brain").fill("stay put");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(lastBrainP(page)).toHaveText(FAKE_REPLY, { timeout: 30_000 });
    expect((await threadMetrics(page)).top).toBeLessThan(80); // still near the top, not at the bottom

    // E9: Jump to newest re-pins → the following send tracks the bottom again
    await page.getByRole("button", { name: "Jump to newest" }).click();
    await page.getByLabel("Message your brain").fill("pin me again");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(lastBrainP(page)).toHaveText(FAKE_REPLY, { timeout: 30_000 });
    await expect.poll(async () => isAtBottom(await threadMetrics(page))).toBe(true);

    // E1: the model is resident → the sidebar chip is GREEN (local + loaded), not gray
    const chip = page.locator(".brain-chip");
    await expect(chip).toHaveClass(/brain-chip-local/, { timeout: 15_000 });
    await expect(chip).not.toHaveClass(/brain-chip-asleep/);

    // E6: over a chip-poll cycle, the load-state probe writes NO non-routine receipts.
    // First wait for all THREE send receipts (E7/E8/E9) to be flushed, so a send's "done" that
    // lags its on-screen reply can't land inside the snapshot window and read as poll noise.
    await expect
      .poll(
        () =>
          readFileSync(receiptsPath, "utf8").trim().split("\n").filter((l) => l.length).map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r["provider"] === "local" && r["phase"] === "done").length,
        { timeout: 15_000 },
      )
      .toBe(3);
    const before = readFileSync(receiptsPath, "utf8").trim().split("\n").filter((l) => l.length);
    await page.waitForTimeout(6_000); // > POLL_MS (5s): at least one chip poll fires
    const added = readFileSync(receiptsPath, "utf8").trim().split("\n").filter((l) => l.length).slice(before.length).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(added.filter((r) => r["routine"] !== true)).toHaveLength(0); // no phantom egress from the poll

    // E5: hide to tray via the REAL close handler — the model must STAY loaded (66bc60c wiped it).
    // Assumes a tray-capable platform (win32/macOS — the target); where a tray can't be created
    // the app quits on close by design, so hide-to-tray doesn't apply.
    const hidden = await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w?.close(); // fires close → preventDefault → hide (tray path)
      return w ? !w.isDestroyed() : false; // true = hidden (not closed) → the hide path engaged
    });
    expect(hidden).toBe(true);
    await app.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show());
    await expect(chip).toHaveClass(/brain-chip-local/, { timeout: 15_000 }); // STILL green after hide/show
    await expect(chip).not.toHaveClass(/brain-chip-asleep/);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

// ── Loop 034: the chip goes GRAY when the model idle-unloads, GREEN again on the next chat ─
// E2 gray-when-unloaded · E4 the live green→gray→green flip driven by the real idle-unload.
test("brain chip goes gray when the model idle-unloads and green again on the next chat", async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      SKOVERN_API_URL: server.url,
      SKOVERN_OLLAMA_URL: "http://127.0.0.1:1",
      SKOVERN_CATALOG_URL: catalogUrl,
      SKOVERN_HARDWARE: GPU_HARDWARE,
      SKOVERN_LLAMA_FAKE: "1",
      SKOVERN_LLAMA_FAKE_DELAY_MS: "50",
      SKOVERN_MODEL_DOWNLOAD_URL: downloadUrl,
      // Must exceed the 5s chip poll so the GREEN (warm) state is actually observed before the
      // model frees itself — a sub-poll idle would unload it invisibly between two polls.
      SKOVERN_IDLE_UNLOAD_MS: "8000",
    },
  });
  try {
    const page = await app.firstWindow();
    await signIn(page, "chip-idle@shop.test");
    await setupLocalEmbeddedBrain(page);
    const chip = page.locator(".brain-chip");

    // load the model with one message → chip GREEN
    await page.getByRole("button", { name: "Chat" }).click();
    await page.getByRole("button", { name: "New chat" }).click();
    await page.getByLabel("Message your brain").fill("wake up");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(lastBrainP(page)).toHaveText(FAKE_REPLY, { timeout: 30_000 });
    await expect(chip).toHaveClass(/brain-chip-local/, { timeout: 15_000 });

    // E2/E4: after the 8s idle the model unloads; the next chip poll (≤5s) turns it GRAY (asleep)
    await expect(chip).toHaveClass(/brain-chip-asleep/, { timeout: 25_000 });

    // green again on the next chat (the model respawns) — no dead end
    await page.getByLabel("Message your brain").fill("wake up again");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(lastBrainP(page)).toHaveText(FAKE_REPLY, { timeout: 30_000 });
    await expect(chip).toHaveClass(/brain-chip-local/, { timeout: 15_000 });
    await expect(chip).not.toHaveClass(/brain-chip-asleep/);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { AuthService, AuthStore, ConsoleMailer, startAuthServer, type RunningServer } from "@deskhand/site";

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

test("chat streams a local reply, persists it, stops mid-stream, and writes one receipt", async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "deskhand-e2e-"));
  const receiptsPath = path.join(userDataDir, "receipts.jsonl");
  const chatsDir = path.join(userDataDir, "chats");

  // Fixture realism (retro-1): the receipts log already holds routine-poll noise AND a
  // prior (cloud) message pair, so "exactly one receipt per chat message" (C8) is proven
  // amid real composition, not a pristine log.
  writeFileSync(
    receiptsPath,
    [
      { kind: "fetch", host: "127.0.0.1", task: "Deskhand: messages", direction: "in", routine: true, ts: "2026-07-14T09:00:00.000Z", bytesSent: 0, bytesReceived: 0, ok: true, phase: "done" },
      { kind: "fetch", host: "127.0.0.1", task: "Deskhand: news", direction: "in", routine: true, ts: "2026-07-14T09:00:05.000Z", bytesSent: 0, bytesReceived: 0, ok: true, phase: "done" },
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
      DESKHAND_API_URL: server.url,
      DESKHAND_OLLAMA_URL: "http://127.0.0.1:1", // Ollama down → embedded path
      DESKHAND_CATALOG_URL: catalogUrl,
      DESKHAND_HARDWARE: GPU_HARDWARE,
      DESKHAND_LLAMA_FAKE: "1", // fake native child, streams the canned reply
      DESKHAND_LLAMA_FAKE_DELAY_MS: "200", // slow enough to observe a mid-stream partial
      DESKHAND_MODEL_DOWNLOAD_URL: downloadUrl, // fixture model bytes
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
  const userDataDir = mkdtempSync(path.join(tmpdir(), "deskhand-e2e-"));
  const ollama = startStreamingOllama();
  const ollamaUrl = await ollama.ready;

  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      DESKHAND_API_URL: server.url,
      DESKHAND_OLLAMA_URL: ollamaUrl, // a REAL (fixture) Ollama, up and streaming
      DESKHAND_CATALOG_URL: catalogUrl, // no embedded model downloaded → no built-in fallback
      DESKHAND_HARDWARE: GPU_HARDWARE, // mistral:7b is usable → "Use this one"
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
  const userDataDir = mkdtempSync(path.join(tmpdir(), "deskhand-e2e-"));
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: { ...process.env, DESKHAND_API_URL: server.url },
  });
  try {
    const page = await app.firstWindow();
    await signIn(page, "nobrain@shop.test");
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
  const userDataDir = mkdtempSync(path.join(tmpdir(), "deskhand-e2e-"));
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: { ...process.env, DESKHAND_API_URL: server.url, DESKHAND_OPENROUTER_BASE_URL: brainUrl },
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
  const userDataDir = mkdtempSync(path.join(tmpdir(), "deskhand-e2e-"));
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    // a cloud brain pointed at a dead port → every send fails fast (ECONNREFUSED). The bug
    // was: a failed send showed NOTHING. It must now show an honest error + re-enable send.
    env: { ...process.env, DESKHAND_API_URL: server.url, DESKHAND_OPENROUTER_BASE_URL: "http://127.0.0.1:1" },
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

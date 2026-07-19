import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { AuthService, AuthStore, ConsoleMailer, startAuthServer, type RunningServer } from "@skovern/site";

// Loop 044 — "Connect your own brain by address." A power user points Skovern at an
// Ollama-compatible server (here a loopback fixture). Ceremony matches egress:
//   E-localhost: a loopback address → NO warning ("stays on your computer") → pick a model → chat.
//   E-offbox: the SKOVERN_FORCE_OFFBOX seam classifies the SAME loopback fixture as off-box →
//     a "this leaves your computer" WARNING + consent BEFORE connecting → after a chat call, an
//     egress receipt (direction:out, host) is on disk — written before the byte (fail-closed).
// The fixture + seam make PASS/FAIL a pure function of the diff (no real remote box in CI).

const REMOTE_MODEL = "my-remote-model";
const REMOTE_REPLY = "Hello from the brain you connected.";

const GPU_HARDWARE = JSON.stringify({
  ramBytes: 16 * 1024 ** 3, cpuCores: 8, gpus: [], bestVramBytes: null, unifiedMemory: false, diskFreeBytes: 200 * 1024 ** 3, notes: [],
});

// An Ollama-compatible "brain" server: /api/tags lists one model; /api/generate streams a reply
// (NDJSON). This is the thing the user connects to.
let brain: Server | null = null;
function startBrain(): Promise<{ url: string; host: string }> {
  return new Promise((resolve) => {
    brain = createServer((req, res) => {
      const url = req.url ?? "";
      if (req.method === "GET" && url === "/api/tags") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: REMOTE_MODEL, size: 4_000_000_000, details: { quantization_level: "Q4_K_M", parameter_size: "7B" } }] }));
        return;
      }
      if (req.method === "POST" && url === "/api/generate") {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(JSON.stringify({ response: REMOTE_REPLY, done: false }) + "\n");
        res.end(JSON.stringify({ done: true, prompt_eval_count: 6, eval_count: 8 }) + "\n");
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
    brain.listen(0, "127.0.0.1", () => {
      const port = (brain!.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` });
    });
  });
}

// A minimal catalog so the local-brain screen renders deterministically offline.
let catalog: Server | null = null;
function startCatalog(): Promise<string> {
  return new Promise((resolve) => {
    catalog = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ id: "qwen2.5:3b", label: "Qwen2.5 3B", params: 3, sizeBytes: 2e9, quant: "Q4_K_M", creator: "Alibaba", homepage: "https://huggingface.co/x", license: "Apache 2.0 — free.", licenseUrl: "https://apache.org/x", tradeoff: "good" }] }));
    });
    catalog.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(catalog!.address() as AddressInfo).port}/catalog/models.json`));
  });
}

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let server: RunningServer;
let mailer: ConsoleMailer;
let brainHost: string;
let catalogUrl: string;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  await new AuthStore(pool).migrate();
  mailer = new ConsoleMailer();
  const auth = new AuthService(new AuthStore(pool), mailer, { appUrl: "https://app.test" });
  server = await startAuthServer({ service: auth });
  const b = await startBrain();
  brainHost = b.host;
  catalogUrl = await startCatalog();
});

test.afterAll(async () => {
  await server?.close();
  await pool?.end();
  await container?.stop();
  brain?.close();
  catalog?.close();
});

async function signInAndOpenLocal(page: Page, email: string): Promise<void> {
  const before = mailer.sent.length;
  await page.getByLabel("Your email").fill(email);
  await page.getByRole("button", { name: "Send me a link" }).click();
  await expect.poll(() => mailer.sent.length, { timeout: 30_000 }).toBeGreaterThan(before);
  await page.getByLabel("Paste your link").fill(mailer.sent[mailer.sent.length - 1]!.url);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText(/founding user #/i)).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Your brain").selectOption("local");
  await page.getByRole("button", { name: "Set up the local brain →" }).click();
  await expect(page.getByRole("heading", { name: "On this computer" })).toBeVisible({ timeout: 30_000 });
}

function launch(userDataDir: string, extraEnv: Record<string, string>) {
  return electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      SKOVERN_API_URL: server.url,
      SKOVERN_OLLAMA_URL: "http://127.0.0.1:1", // loopback Ollama is DOWN — proves the connected lane is independent
      SKOVERN_OLLAMA_INSTALLED: "0",
      SKOVERN_CATALOG_URL: catalogUrl,
      SKOVERN_HARDWARE: GPU_HARDWARE,
      ...extraEnv,
    },
  });
}

test("E-localhost: connect a loopback brain — light confirm, no egress, pick + chat works", async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const app = await launch(userDataDir, {});
  try {
    const page = await app.firstWindow();
    await signInAndOpenLocal(page, "connect-local@shop.test");

    const connect = page.locator(".connect-brain");
    await expect(connect.getByRole("heading", { name: "Connect your own brain" })).toBeVisible();
    await connect.getByLabel("Brain address").fill(brainHost); // 127.0.0.1:<port> — loopback
    await connect.getByRole("button", { name: "Connect" }).click();

    // Loopback → NO off-box warning; a reassuring "nothing leaves it" line + the model list.
    await expect(connect.getByText(/nothing leaves it/i)).toBeVisible({ timeout: 15_000 });
    await expect(connect.getByText(/leave this computer/i)).toHaveCount(0);
    await connect.getByRole("button", { name: "Use this one" }).click();
    await expect(connect.getByText(new RegExp(`${REMOTE_MODEL} is now your brain`, "i"))).toBeVisible({ timeout: 15_000 });

    // The connected brain actually answers a chat (proving it routes to the endpoint, not loopback
    // Ollama which is DOWN here).
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByLabel("Message your brain").fill("hi");
    await page.getByLabel("Message your brain").press("Enter");
    await expect(page.locator(".chat-thread .from-brain p").last()).toHaveText(REMOTE_REPLY, { timeout: 30_000 });

    // NO egress receipt for a loopback connection (nothing left the machine).
    const log = readFileSync(path.join(userDataDir, "receipts.jsonl"), "utf8");
    expect(log).not.toContain("your connected brain");
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("E-offbox: an off-box address warns + requires consent, then every call is receipted before the byte", async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const app = await launch(userDataDir, { SKOVERN_FORCE_OFFBOX: "1" }); // classify the loopback fixture as off-box
  try {
    const page = await app.firstWindow();
    await signInAndOpenLocal(page, "connect-offbox@shop.test");

    const connect = page.locator(".connect-brain");
    await connect.getByLabel("Brain address").fill(brainHost);
    await connect.getByRole("button", { name: "Connect" }).click();

    // Off-box → a clear warning + consent BEFORE any byte leaves. No model list yet.
    await expect(connect.getByText(/leave this computer/i)).toBeVisible({ timeout: 15_000 });
    await expect(connect.getByRole("button", { name: "Use this one" })).toHaveCount(0);
    // No receipt yet — we haven't consented, so nothing has been sent.
    expect(readFileSync(path.join(userDataDir, "receipts.jsonl"), "utf8")).not.toContain("your connected brain");

    // Consent → NOW it probes (the first off-box call) → models appear → pick one.
    await connect.getByRole("button", { name: /connect anyway/i }).click();
    await connect.getByRole("button", { name: "Use this one" }).click();
    await expect(connect.getByText(new RegExp(`${REMOTE_MODEL} is now your brain`, "i"))).toBeVisible({ timeout: 15_000 });

    // A chat reply works…
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByLabel("Message your brain").fill("hi");
    await page.getByLabel("Message your brain").press("Enter");
    await expect(page.locator(".chat-thread .from-brain p").last()).toHaveText(REMOTE_REPLY, { timeout: 30_000 });

    // …and every off-box call is receipted, with a "sent" phase written BEFORE the byte (fail-closed).
    const log = readFileSync(path.join(userDataDir, "receipts.jsonl"), "utf8");
    const connectLines = log.split("\n").filter((l) => l.includes("your connected brain"));
    expect(connectLines.length).toBeGreaterThan(0);
    expect(connectLines.some((l) => l.includes('"phase":"sent"') && l.includes('"direction":"out"'))).toBe(true);
    expect(connectLines.some((l) => l.includes(brainHost))).toBe(true); // the host is named (not the prompt)
    expect(log).not.toContain("hi\",\"prompt"); // the message body never enters the log

    // The Receipts page surfaces it as an outbound entry.
    await page.getByRole("button", { name: "Receipts" }).click();
    await expect(page.getByText(brainHost).first()).toBeVisible({ timeout: 30_000 });
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

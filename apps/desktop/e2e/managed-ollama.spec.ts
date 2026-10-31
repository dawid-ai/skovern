import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { AuthService, AuthStore, ConsoleMailer, startAuthServer, type RunningServer } from "@skovern/site";
import { fakeOllamaZip } from "./zip-fixture.js";

// Loop 047 metric: on a computer whose best brain runs through Ollama and that has no Ollama,
// onboarding recommends that brain; one consent sets the helper up (download → unpack → start)
// and gets the brain, every download receipted; failures read in plain words. Fixture = the
// SHIPPED catalog on a 24 GB card. Helper bytes, Ollama, hardware, disk and spawn are seamed, so
// PASS/FAIL is a pure function of the diff. The real 1.4 GB helper + 20 GB brain are HW H1.

const SHIPPED = readFileSync(fileURLToPath(new URL("../../../catalog/models.json", import.meta.url)), "utf8");
const ZIP = fakeOllamaZip();
const ZIP_SHA = createHash("sha256").update(ZIP).digest("hex");
const REPLY = "Hello — I'm your big private brain.";
const GB = 1024 ** 3;
const hw = (p: object) =>
  JSON.stringify({ ramBytes: 64 * GB, cpuCores: 16, gpus: [], bestVramBytes: null, unifiedMemory: false, diskFreeBytes: 500 * GB, notes: [], ...p });
const CARD_24 = hw({ gpus: [{ model: "AMD Radeon RX 7900 XTX", vramBytes: 24 * GB }], bestVramBytes: 24 * GB });
const CPU_16 = hw({ ramBytes: 16 * GB });

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let server: RunningServer;
let mailer: ConsoleMailer;
const servers: Server[] = [];

function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  return new Promise((resolve) => {
    const s = createServer(handler);
    servers.push(s);
    s.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`));
  });
}

// What a request saw on arrival: was the matching "sent" receipt already on disk?
function receiptsOf(dir: string): { host: string; phase: string; ok: boolean; bytesReceived: number }[] {
  const f = path.join(dir, "receipts.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { host: string; phase: string; ok: boolean; bytesReceived: number });
}
const sentFor = (dir: string, host: string) => receiptsOf(dir).some((r) => r.host === host && r.phase === "sent");

/** A fixture set for one app run: the catalog, the helper download, and the fake Ollama. */
async function fixtures(
  dir: string,
  opts: { pullError?: string; dropFirstHelper?: boolean; ollamaUp?: boolean; slowPullMs?: number; neverUp?: boolean; catalogDelayMs?: number } = {},
) {
  const seen = { helperRequests: 0, helperSawReceipt: false, pullRequests: 0, pullSawReceipt: false, ranges: [] as string[] };
  const state = { up: opts.ollamaUp ?? false };
  const catalogUrl = await listen((_q, s) => {
    setTimeout(() => {
      s.writeHead(200, { "content-type": "application/json" });
      s.end(SHIPPED);
    }, opts.catalogDelayMs ?? 0);
  });
  const helperUrl = await listen((req, s) => {
    seen.helperRequests++;
    seen.helperSawReceipt ||= sentFor(dir, "github.com");
    seen.ranges.push(req.headers.range ?? "");
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    if (opts.dropFirstHelper && seen.helperRequests === 1) {
      // Send half, then cut the connection: the download must resume, not restart.
      s.writeHead(200, { "content-type": "application/zip", "content-length": String(ZIP.length) });
      s.write(ZIP.subarray(0, Math.floor(ZIP.length / 2)), () => s.destroy());
      return;
    }
    const from = range ? Number(range[1]) : 0;
    s.writeHead(range ? 206 : 200, { "content-type": "application/zip" });
    s.end(ZIP.subarray(from));
    if (!opts.neverUp) state.up = true; // the helper is "installed" → our fake Ollama answers from now on
  });
  const ollamaUrl = await listen((req, s) => {
    const url = req.url ?? "";
    if (!state.up) {
      s.destroy();
      return;
    }
    if (req.method === "GET" && url === "/api/tags") {
      s.writeHead(200, { "content-type": "application/json" });
      // The 037 flip case: an Ollama of the user's own with a BIGGER pulled brain that isn't in the
      // catalog, green on 24 GB. It must never become the pick (checker N11).
      s.end(JSON.stringify({ models: opts.ollamaUp ? [{ name: "mybig:33b", size: 20_000_000_000, details: { quantization_level: "Q4_K_M", parameter_size: "33B" } }] : [] }));
      return;
    }
    if (req.method === "POST" && url === "/api/pull") {
      seen.pullRequests++;
      seen.pullSawReceipt ||= sentFor(dir, "registry.ollama.ai");
      s.writeHead(200, { "content-type": "application/x-ndjson" });
      if (opts.pullError) {
        s.end(JSON.stringify({ error: opts.pullError }) + "\n");
        return;
      }
      s.write(JSON.stringify({ status: "pulling abc", completed: 600, total: 1000 }) + "\n");
      setTimeout(() => {
        s.write(JSON.stringify({ status: "pulling abc", completed: 1000, total: 1000 }) + "\n");
        s.end(JSON.stringify({ status: "success" }) + "\n");
      }, opts.slowPullMs ?? 0);
      return;
    }
    if (req.method === "POST" && url === "/api/generate") {
      s.writeHead(200, { "content-type": "application/x-ndjson" });
      s.write(JSON.stringify({ response: REPLY, done: false }) + "\n");
      s.end(JSON.stringify({ response: "", done: true }) + "\n");
      return;
    }
    s.writeHead(404);
    s.end("{}");
  });
  return { seen, state, catalogUrl, helperUrl, ollamaUrl };
}

type Fx = Awaited<ReturnType<typeof fixtures>>;

function envFor(fx: Fx, over: Record<string, string> = {}) {
  return {
    ...process.env,
    SKOVERN_API_URL: server.url,
    SKOVERN_CATALOG_URL: `${fx.catalogUrl}/catalog/models.json`,
    SKOVERN_HARDWARE: CARD_24,
    SKOVERN_OLLAMA_URL: fx.ollamaUrl,
    SKOVERN_OLLAMA_INSTALLED: "0", // no Ollama of the user's own
    SKOVERN_OLLAMA_SPAWN_FAKE: "serve",
    SKOVERN_OLLAMA_DIST: "", // undo the config's "off": this spec turns the helper on
    SKOVERN_OLLAMA_DIST_URL: `${fx.helperUrl}/ollama.zip`,
    SKOVERN_OLLAMA_DIST_SHA256: ZIP_SHA,
    SKOVERN_OLLAMA_DIST_SIZE: String(ZIP.length),
    SKOVERN_FREE_DISK_BYTES: String(1000 * GB),
    ...over,
  };
}

async function launch(dir: string, env: Record<string, string | undefined>): Promise<ElectronApplication> {
  return electron.launch({ args: [".", `--user-data-dir=${dir}`], env: env as Record<string, string> });
}

async function signIn(page: Page, email: string): Promise<void> {
  const before = mailer.sent.length;
  await page.getByLabel("Your email").fill(email);
  await page.getByRole("button", { name: "Send me a link" }).click();
  await expect.poll(() => mailer.sent.length, { timeout: 30_000 }).toBeGreaterThan(before);
  await page.getByLabel("Paste your link").fill(mailer.sent[mailer.sent.length - 1]!.url);
  await page.getByRole("button", { name: "Verify" }).click();
}

async function toGuided(page: Page, email: string): Promise<void> {
  await signIn(page, email);
  await expect(page.getByText(/Set up your brain to get started/i)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Set it up →" }).click();
  await page.getByRole("button", { name: "Set up my private brain →" }).click();
  await expect(page.getByRole("heading", { name: "On this computer", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".local-callouts .callout h3")).toBeVisible({ timeout: 30_000 });
}

const hero = (page: Page) => page.locator(".local-callouts .callout").first();

// Record every progress tick the renderer receives, in order.
async function recordPhases(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __phases: string[] };
    w.__phases = [];
    window.skovern.local.onPullProgress((p) => {
      if (p.phase && w.__phases[w.__phases.length - 1] !== p.phase) w.__phases.push(p.phase);
    });
  });
}

function fresh(): string {
  return mkdtempSync(path.join(tmpdir(), "skovern-047-"));
}
const ollamaDirEntries = (dir: string) => (existsSync(path.join(dir, "ollama")) ? readdirSync(path.join(dir, "ollama")) : []);

test.beforeAll(async () => {
  test.setTimeout(180_000);
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  await new AuthStore(pool).migrate();
  mailer = new ConsoleMailer();
  server = await startAuthServer({ service: new AuthService(new AuthStore(pool), mailer, { appUrl: "https://app.test" }) });
});

test.afterAll(async () => {
  await server?.close();
  await pool?.end();
  await container?.stop();
  for (const s of servers) s.close();
});

test("M1: a 24 GB card is offered the 32B; headline and hero agree; the pick doesn't move when an Ollama of the user's own is up", async () => {
  test.setTimeout(180_000);
  const picks: string[] = [];
  for (const userOllama of [false, true]) {
    const dir = fresh();
    const fx = await fixtures(dir, { ollamaUp: userOllama });
    const app = await launch(dir, envFor(fx, userOllama ? { SKOVERN_OLLAMA_INSTALLED: "1" } : {}));
    try {
      const page = await app.firstWindow();
      await toGuided(page, `m1-${userOllama}@shop.test`);
      const pick = (await hero(page).locator("h3").innerText()).trim();
      await expect(page.locator(".local-headline")).toContainText(pick);
      picks.push(pick);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  expect(picks).toEqual(["Qwen2.5 32B", "Qwen2.5 32B"]);
});

test("M2 + M6: one consent names the helper and the total size; Not now leaves nothing behind; it fits an 800×600 window", async () => {
  test.setTimeout(120_000);
  const dir = fresh();
  const fx = await fixtures(dir);
  const app = await launch(dir, envFor(fx));
  try {
    const page = await app.firstWindow();
    await toGuided(page, "m2@shop.test");
    await app.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ width: 800, height: 600 }));
    await hero(page).getByRole("button", { name: "Get this one" }).click();
    const consent = page.getByRole("dialog", { name: "Set up the helper" });
    await expect(consent).toContainText("Ollama");
    await expect(consent).toContainText(/About \d+ GB to download/);
    for (const b of [consent.getByRole("button", { name: "Set it up" }), consent.getByRole("button", { name: "Not now" })]) {
      await b.scrollIntoViewIfNeeded();
      await expect(b).toBeInViewport();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    // E3 (rewritten, 047): "Ollama" appears on the guided screen only inside this consent.
    const outside = await page.locator(".page").evaluate((el) => {
      const c = el.cloneNode(true) as HTMLElement;
      c.querySelectorAll(".helper-consent").forEach((n) => n.remove());
      return c.innerText.toLowerCase();
    });
    expect(outside).not.toContain("ollama");

    await consent.getByRole("button", { name: "Not now" }).click();
    await expect(consent).toHaveCount(0);
    await expect(hero(page).getByRole("button", { name: "Get this one" })).toBeEnabled();
    expect(fx.seen.helperRequests).toBe(0);
    expect(receiptsOf(dir).filter((r) => r.host === "github.com" || r.host === "registry.ollama.ai")).toEqual([]);
    expect(ollamaDirEntries(dir)).toEqual([]);
    expect(await page.evaluate(() => window.skovern.settings.ollamaStatus().then((s) => s.launchAttempts ?? 0))).toBe(0);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M3 + M5: set it up → helper, unpack, start, brain in order → receipted → chat answers; after a restart it starts without asking", async () => {
  test.setTimeout(240_000);
  const dir = fresh();
  const fx = await fixtures(dir);
  let app = await launch(dir, envFor(fx));
  try {
    const page = await app.firstWindow();
    await toGuided(page, "m3@shop.test");
    await recordPhases(page);
    await hero(page).getByRole("button", { name: "Get this one" }).click();
    await page.getByRole("button", { name: "Set it up" }).click();
    // M4(f): while it runs, there's nothing to click a second time for this brain.
    await expect(page.getByRole("button", { name: "Set it up" })).toHaveCount(0);
    await expect(page.getByText("Local: qwen2.5:32b")).toBeVisible({ timeout: 60_000 });
    expect(await page.evaluate(() => (window as unknown as { __phases: string[] }).__phases)).toEqual(["helper", "unpack", "start", "brain"]);

    // Receipts: a "sent" on disk BEFORE each server saw its request, then a "done".
    expect(fx.seen.helperSawReceipt).toBe(true);
    expect(fx.seen.pullSawReceipt).toBe(true);
    const r = receiptsOf(dir);
    expect(r.filter((x) => x.host === "github.com").map((x) => [x.phase, x.ok])).toEqual([["sent", false], ["done", true]]);
    expect(r.filter((x) => x.host === "registry.ollama.ai").map((x) => [x.phase, x.ok])).toEqual([["sent", false], ["done", true]]);
    expect(r.find((x) => x.host === "registry.ollama.ai" && x.phase === "done")!.bytesReceived).toBe(1000);
    expect(ollamaDirEntries(dir)).toEqual(["0.0.0-test"]); // unpacked, zip removed

    // M11 / checker B3: now the helper is set up, running, and the brain downloaded — the pick and
    // the headline still name the 32B. A pick that read any of that state would move here.
    const after = await page.evaluate(async () => {
      const [m, s] = await Promise.all([window.skovern.local.models(), window.skovern.local.status()]);
      return { pick: m.models.find((x) => x.recommended)?.id ?? null, headline: s.verdict.headline, helper: m.helper };
    });
    expect(after.pick).toBe("qwen2.5:32b");
    expect(after.headline).toContain("Qwen2.5 32B");
    expect(after.helper).toBeNull(); // set up → no second consent

    await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Chat" }).click();
    await page.getByRole("button", { name: "New chat" }).click();
    await page.getByLabel("Message your brain").fill("hello");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText(REPLY)).toBeVisible({ timeout: 30_000 });
  } finally {
    await app.close();
  }

  // M5: relaunch with the helper not running. A chat makes Skovern start it — no prompt.
  fx.state.up = false;
  app = await launch(dir, envFor(fx));
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Chat" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Chat" }).click();
    await page.getByRole("button", { name: "New chat" }).click();
    await page.getByLabel("Message your brain").fill("are you there?");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    // The fake spawn can't serve, so "start" the fixture shortly after Skovern tries to.
    setTimeout(() => (fx.state.up = true), 1_500);
    await expect(page.getByText(REPLY)).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => window.skovern.settings.ollamaStatus().then((s) => s.launchAttempts ?? 0))).toBeGreaterThan(0);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M4(f) + M6: leaving and coming back mid-set-up shows the running set-up — nothing to start twice — and the bar fits 800×600", async () => {
  test.setTimeout(180_000);
  const dir = fresh();
  const fx = await fixtures(dir, { slowPullMs: 8_000 });
  const app = await launch(dir, envFor(fx));
  try {
    const page = await app.firstWindow();
    await toGuided(page, "m4f@shop.test");
    await app.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ width: 800, height: 600 }));
    await hero(page).getByRole("button", { name: "Get this one" }).click();
    await page.getByRole("button", { name: "Set it up" }).click();
    await expect(hero(page).locator(".pull-progress")).toContainText("Getting the brain", { timeout: 30_000 });
    const bar = hero(page).locator(".pull-progress");
    await bar.scrollIntoViewIfNeeded();
    await expect(bar).toBeInViewport();

    // Leave the screen and come back while the brain is still downloading.
    await page.getByRole("button", { name: "← Back" }).click();
    await page.getByRole("button", { name: "Set up my private brain →" }).click();
    await expect(page.getByRole("heading", { name: "On this computer", exact: true })).toBeVisible();
    await expect(hero(page).locator(".pull-progress")).toContainText("Getting the brain", { timeout: 15_000 });
    await expect(hero(page).getByRole("button", { name: "Get this one" })).toHaveCount(0);
    // Even a direct second call is refused while one runs.
    const second = await page.evaluate(() => window.skovern.local.setUp("qwen2.5:32b"));
    expect(second.ok).toBe(false);
    expect(second.message).toMatch(/already getting a brain ready/);

    // At 800×600 the sidebar is an icon rail (design A), so the chip's words are visually hidden
    // but still its text.
    await expect(page.locator(".brain-chip")).toContainText("Local: qwen2.5:32b", { timeout: 60_000 });
    expect(fx.seen.helperRequests).toBe(1);
    expect(fx.seen.pullRequests).toBe(1);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Checker iteration 2, B4: two calls in the same moment (a double click, a second window) — one
// set-up runs, the other is refused, and nothing is downloaded twice.
test("M4(f): two set-up calls at once → one runs, one is refused", async () => {
  test.setTimeout(120_000);
  const dir = fresh();
  const fx = await fixtures(dir, { catalogDelayMs: 300 });
  const app = await launch(dir, envFor(fx));
  try {
    const page = await app.firstWindow();
    await toGuided(page, "m4f-race@shop.test");
    // Let the 3 s catalog cache lapse, so both calls really wait on the (slow) catalog together —
    // the moment a check-then-await guard would let both through.
    await page.waitForTimeout(3_500);
    const results = await page.evaluate(() => Promise.all([window.skovern.local.setUp("qwen2.5:32b"), window.skovern.local.setUp("qwen2.5:32b")]));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => r.message)).toEqual([expect.stringMatching(/already getting a brain ready/)]);
    expect(fx.seen.helperRequests).toBe(1);
    expect(fx.seen.pullRequests).toBe(1);
    // A brain Skovern can't set up frees the slot again.
    expect((await page.evaluate(() => window.skovern.local.setUp("not-a-catalog-brain"))).message).toMatch(/isn't one Skovern can set up/);
    expect(await page.evaluate(() => window.skovern.local.setUpStatus())).toBeNull();
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test.describe("M4: when something goes wrong, it says so plainly and can be tried again", () => {
  async function runTo(email: string, fxOpts: Parameters<typeof fixtures>[1], envOver: Record<string, string>, expectText: RegExp) {
    const dir = fresh();
    const fx = await fixtures(dir, fxOpts);
    const app = await launch(dir, envFor(fx, envOver));
    const page = await app.firstWindow();
    await toGuided(page, email);
    await hero(page).getByRole("button", { name: "Get this one" }).click();
    await page.getByRole("button", { name: "Set it up" }).click();
    await expect(hero(page).getByRole("alert")).toContainText(expectText, { timeout: 60_000 });
    await expect(hero(page).getByRole("button", { name: "Try again" })).toBeVisible();
    return { dir, fx, app, page };
  }

  test("(a) the helper fails its safety check → nothing set up, nothing run", async () => {
    test.setTimeout(120_000);
    const { dir, app, page } = await runTo("m4a@shop.test", {}, { SKOVERN_OLLAMA_DIST_SHA256: "0".repeat(64) }, /didn't match its safety check/);
    try {
      expect(ollamaDirEntries(dir)).toEqual([]);
      expect(await page.evaluate(() => window.skovern.settings.ollamaStatus().then((s) => s.launchAttempts ?? 0))).toBe(0);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("(b) the helper download drops half-way → Try again resumes it and finishes", async () => {
    test.setTimeout(150_000);
    const { dir, fx, app, page } = await runTo("m4b@shop.test", { dropFirstHelper: true }, {}, /download stopped|picks up where it left off/i);
    try {
      await hero(page).getByRole("button", { name: "Try again" }).click(); // consent already given — no second ask
      await expect(page.getByRole("dialog", { name: "Set up the helper" })).toHaveCount(0);
      await expect(page.getByText("Local: qwen2.5:32b")).toBeVisible({ timeout: 60_000 });
      expect(fx.seen.helperRequests).toBe(2);
      expect(fx.seen.ranges[1]).toMatch(/^bytes=\d+-$/); // resumed from where it stopped (checker N3)
      expect(fx.seen.ranges[1]).not.toBe("bytes=0-");
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("(c) the helper won't start → plain message, no brain download, built-ins still offered", async () => {
    test.setTimeout(120_000);
    const { dir, fx, app, page } = await runTo("m4c@shop.test", { neverUp: true }, { SKOVERN_OLLAMA_SPAWN_FAKE: "1" }, /didn't start/);
    try {
      expect(fx.seen.pullRequests).toBe(0);
      const more = page.locator("details.local-other-options");
      await more.locator("summary").click();
      await expect(more.getByText("Qwen2.5 14B")).toBeVisible();
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("(d) the brain download fails → plain words, never Ollama's raw error", async () => {
    test.setTimeout(120_000);
    const raw = "read tcp 127.0.0.1:50123->104.21.1.1:443: wsarecv: An existing connection was forcibly closed by the remote host.";
    const { dir, app, page } = await runTo("m4d@shop.test", { pullError: raw }, {}, /brain download stopped/);
    try {
      await expect(hero(page)).not.toContainText(/wsarecv|tcp|forcibly/);
      expect(receiptsOf(dir).filter((x) => x.host === "registry.ollama.ai").map((x) => [x.phase, x.ok])).toEqual([["sent", false], ["done", false]]);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("(e) not enough room for the helper and the brain → refused before any byte leaves", async () => {
    test.setTimeout(120_000);
    const { dir, fx, app } = await runTo("m4e@shop.test", {}, { SKOVERN_FREE_DISK_BYTES: String(5 * GB) }, /enough free space .* brain and its helper/);
    try {
      expect(fx.seen.helperRequests).toBe(0);
      expect(receiptsOf(dir).filter((x) => x.host === "github.com")).toEqual([]);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("M7: a small computer is never asked to set up the helper", async () => {
  test.setTimeout(120_000);
  const dir = fresh();
  const fx = await fixtures(dir);
  const app = await launch(dir, envFor(fx, { SKOVERN_HARDWARE: CPU_16 }));
  try {
    const page = await app.firstWindow();
    await toGuided(page, "m7@shop.test");
    const pick = (await hero(page).locator("h3").innerText()).trim();
    const shipped = JSON.parse(SHIPPED) as { models: { label: string; gguf?: unknown }[] };
    expect(shipped.models.find((m) => m.label === pick)?.gguf).toBeDefined(); // a built-in
    await expect(page.getByRole("dialog", { name: "Set up the helper" })).toHaveCount(0);
    expect(await page.locator(".page").innerText()).not.toMatch(/ollama/i);
    expect(fx.seen.helperRequests).toBe(0);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

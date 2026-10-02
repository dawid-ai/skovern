import { fork } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { AuthService, AuthStore, ConsoleMailer, startAuthServer, type RunningServer } from "@skovern/site";

// Loop 029 PACKAGING metric. Proves a PACKAGED Windows build (not the dev/source build)
// actually works on a fresh machine:
//   P1 — the NATIVE node-llama-cpp runtime LOADS from the packaged app (asarUnpack'd .node),
//        via the exact production spawn (Electron binary + ELECTRON_RUN_AS_NODE). No model
//        needed — getLlama() loads the addon and the child reports "ready". Real inference
//        is GPU/model-coupled → hand-validation, not this metric.
//   P2 — systeminformation survives packaging: the real hardware scan returns concrete
//        specs, not the "unknown" degraded fallback.
//   P3 — the dev seams are INERT when packaged: hostile SKOVERN_* env vars can't redirect
//        the catalog or fake the hardware verdict. (Security must-pass negative.)
//   P4 — the packaged renderer carries the STRICT CSP, not the dev CSP.
//
// Requires a packaged build first (`pnpm run package:win`). The exe path below is the
// electron-builder --dir output.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WIN_UNPACKED = path.resolve(__dirname, "../dist/win-unpacked");
const EXE = path.join(WIN_UNPACKED, "Skovern.exe");
// The forked runtime child, inside the packed app.asar (its native addon resolves from
// app.asar.unpacked). Same file + same ELECTRON_RUN_AS_NODE fork main uses in production.
const CHILD_IN_ASAR = "resources/app.asar/out/main/llama-child.js";

// A hostile hardware profile: if the seam were (wrongly) honored when packaged, this GPU
// name would show in the UI. It must NOT — the real scan wins.
const EVIL_GPU = "EVILGPU9000";
const EVIL_HARDWARE = JSON.stringify({
  ramBytes: 999 * 1024 ** 3,
  cpuCores: 999,
  gpus: [{ model: EVIL_GPU, vramBytes: 999 * 1024 ** 3 }],
  bestVramBytes: 999 * 1024 ** 3,
  unifiedMemory: false,
  diskFreeBytes: 999 * 1024 ** 3,
  notes: [],
});
// A hostile catalog host: if the seam were honored, the receipted catalog fetch would show
// this host on disk. It must NOT appear — the packaged app fetches its real catalog.
const EVIL_CATALOG = "https://evilcatalog.test/models.json";

test.describe("packaged Windows build (loop 029)", () => {
  test.skip(!existsSync(EXE), `no packaged build at ${EXE} — run \`pnpm run package:win\` first`);

  // P1 — no server / no UI needed: just prove the native runtime loads from the package.
  test("P1: the native runtime loads from the packaged app (getLlama → ready)", async () => {
    test.setTimeout(60_000);
    const type = await new Promise<string>((resolve, reject) => {
      const child = fork(CHILD_IN_ASAR, [], {
        execPath: EXE,
        cwd: WIN_UNPACKED,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("runtime child never reported ready/load-error"));
      }, 45_000);
      child.on("message", (m: { type?: string }) => {
        if (m?.type === "ready" || m?.type === "load-error") {
          clearTimeout(timer);
          child.kill();
          resolve(m.type);
        }
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    // "ready" = the native addon loaded + initialized from app.asar.unpacked. "load-error"
    // means the .node wasn't bundled/reachable — the exact packaging failure this guards.
    expect(type).toBe("ready");
  });

  // P2/P3/P4 need the app running + signed in, so it reaches the local-brain screen.
  test.describe("packaged app UI", () => {
    let container: StartedPostgreSqlContainer;
    let pool: pg.Pool;
    let server: RunningServer;
    let mailer: ConsoleMailer;

    test.beforeAll(async () => {
      test.setTimeout(180_000);
      container = await new PostgreSqlContainer("postgres:17-alpine").start();
      pool = new pg.Pool({ connectionString: container.getConnectionUri() });
      await new AuthStore(pool).migrate();
      mailer = new ConsoleMailer();
      const auth = new AuthService(new AuthStore(pool), mailer, { appUrl: "https://app.test" });
      server = await startAuthServer({ service: auth });
    });

    test.afterAll(async () => {
      await server?.close();
      await pool?.end();
      await container?.stop();
    });

    test("P2/P3/P4: real hardware scan, seams inert, strict CSP", async () => {
      test.setTimeout(180_000);
      const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-pkg-"));
      const app = await electron.launch({
        executablePath: EXE,
        args: [`--user-data-dir=${userDataDir}`],
        env: {
          ...process.env,
          SKOVERN_API_URL: server.url, // the ONE honored seam (hosted-URL injection, not gated)
          // Every local-brain seam set HOSTILE — a packaged app must ignore all of them:
          SKOVERN_HARDWARE: EVIL_HARDWARE,
          SKOVERN_CATALOG_URL: EVIL_CATALOG,
          SKOVERN_MODEL_DOWNLOAD_URL: "https://evildownload.test/model.gguf",
          SKOVERN_OLLAMA_URL: "https://evilollama.test",
          SKOVERN_LLAMA_FAKE: "1",
        },
      });

      try {
        const page = await app.firstWindow();

        // P4 — the packaged renderer carries the STRICT CSP (no dev unsafe-inline / ws://).
        const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
        expect(csp).toContain("default-src 'self'");
        expect(csp).toContain("connect-src 'self'");
        expect(csp).not.toContain("unsafe-inline");
        expect(csp).not.toContain("ws://");

        // sign in (SKOVERN_API_URL points at the test auth server)
        await page.getByLabel("Your email").fill("fresh@shop.test");
        await page.getByRole("button", { name: "Send me a link" }).click();
        await expect.poll(() => mailer.sent.length, { timeout: 30_000 }).toBeGreaterThan(0);
        await page.getByLabel("Paste your link").fill(mailer.sent[mailer.sent.length - 1]!.url);
        await page.getByRole("button", { name: "Verify" }).click();
        await expect(page.getByText(/founding user #1/i)).toBeVisible();

        // to the local-brain screen (runs the real hardware scan + real catalog fetch)
        await page.getByRole("button", { name: "Settings" }).click();
        await page.getByLabel("Pick a brain").selectOption("local");
        await page.getByRole("button", { name: "Set up the local brain →" }).click();
        await expect(page.getByRole("heading", { name: "On this computer" })).toBeVisible({ timeout: 30_000 });

        const specs = page.locator("ul.local-specs");
        await expect(specs).toBeVisible({ timeout: 30_000 });

        // P2 — the REAL scan produced concrete specs (systeminformation survived packaging),
        // not the all-unknown degraded fallback.
        await expect(specs).toContainText(/processor cores/);
        await expect(specs).not.toContainText("Processor unknown");

        // P3 — the hostile SKOVERN_HARDWARE was IGNORED: its sentinel GPU never appears.
        await expect(specs).not.toContainText(EVIL_GPU);

        // P3 — the hostile SKOVERN_CATALOG_URL was IGNORED: no receipt to the evil host is
        // ever written (the packaged app fetched its real catalog, or fell back to snapshot).
        const logPath = path.join(userDataDir, "receipts.jsonl");
        const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
        expect(log).not.toContain("evilcatalog.test");
      } finally {
        await app.close();
        rmSync(userDataDir, { recursive: true, force: true });
      }
    });
  });
});

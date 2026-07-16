import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { AuthService, AuthStore, ConsoleMailer, startAuthServer, type RunningServer } from "@skovern/site";

// Loop 012b metric (app-level, THROUGH THE REAL host): sign in → open Skills → see
// the bundled Hello skill + its permission card → Run → its result (from a fetch
// against a loopback mock) shows, React-escaped → a kind:"fetch" receipt is on disk.
// Plus the sandbox proof on the REAL Electron utilityProcess: the child is denied
// reading a file outside its dir and denied spawning a subprocess.

const PAGE_BODY = "Fresh flowers arrived today — tulips and peonies.";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let server: RunningServer;
let mailer: ConsoleMailer;
let web: Server;
let webUrl: string;

// A tiny loopback web page the Hello skill reads through the host-brokered fetch.
function startMockWeb(): Promise<string> {
  return new Promise((resolve) => {
    web = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(PAGE_BODY);
    });
    web.listen(0, "127.0.0.1", () => {
      const { port } = web.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}/`);
    });
  });
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  await new AuthStore(pool).migrate();
  mailer = new ConsoleMailer();
  const auth = new AuthService(new AuthStore(pool), mailer, { appUrl: "https://app.test" });
  server = await startAuthServer({ service: auth });
  webUrl = await startMockWeb();
});

test.afterAll(async () => {
  await server?.close();
  await pool?.end();
  await container?.stop();
  web?.close();
});

test("user runs the Hello skill and sees its result + a fetch receipt; the child is sandboxed", async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      SKOVERN_API_URL: server.url,
      // dev/test seams: let the skill reach the loopback mock (off in production)
      SKOVERN_PLUGIN_ALLOW_LOOPBACK: "1",
      SKOVERN_HELLO_URL: webUrl,
    },
  });

  try {
    const page = await app.firstWindow();

    // sign in
    await page.getByLabel("Your email").fill("skills@shop.test");
    await page.getByRole("button", { name: "Send me a link" }).click();
    await expect.poll(() => mailer.sent.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.getByLabel("Paste your link").fill(mailer.sent[mailer.sent.length - 1]!.url);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText(/founding user #1/i)).toBeVisible();

    // open Skills — the Hello skill and its plain-English permission card are shown
    await page.getByRole("button", { name: "Skills" }).click();
    await expect(page.getByRole("heading", { name: "Skills" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Hello skill" })).toBeVisible();
    await expect(page.getByText(/Read pages from the internet/)).toBeVisible();

    // run it — the mock's page content comes back through the brokered fetch
    await page.getByRole("button", { name: "Run" }).click();
    await expect(page.getByText(new RegExp(PAGE_BODY.slice(0, 20)))).toBeVisible({ timeout: 30_000 });

    // the fetch was receipted, durably, on disk — metadata only (host, not the URL)
    const log = readFileSync(path.join(userDataDir, "receipts.jsonl"), "utf8");
    expect(log).toContain('"kind":"fetch"');
    expect(log).toContain('"host":"127.0.0.1');
    expect(log).not.toContain(PAGE_BODY); // the body never lands in a receipt

    // SANDBOX PROOF on the shipping runtime (Electron binary under the Permission
    // Model): the child is denied reading a file outside its dir + denied a subprocess.
    const sandbox = await page.evaluate(() => window.skovern.plugins.sandboxCheck());
    expect(sandbox.fsReadDenied).toBe(true);
    expect(sandbox.spawnDenied).toBe(true);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

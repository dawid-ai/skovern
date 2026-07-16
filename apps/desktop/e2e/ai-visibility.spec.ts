import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { AuthService, AuthStore, ConsoleMailer, startAuthServer, type RunningServer } from "@skovern/site";

// Loop 013a metric (app-level, THROUGH THE REAL sandboxed host): sign in → connect a
// brain → open Skills → open AI Visibility → check a business → the score + verbatim
// answers + competitors + fix-its render. The brain runs against a mock OpenAI server
// (no network/real key in CI). The answer carries a <script>, which must render as
// ESCAPED text (S2), and a model receipt must be on disk with metadata only.

const FAKE_KEY = "sk-fake-test-key-should-never-be-logged";
// One canned answer for every prompt. It names the business (→ score 100) and, to
// exercise loop 018's markdown rendering + its safety net, it carries:
//   - real markdown: **bold** and a "- " bullet list  (M1: renders as <strong>/<li>)
//   - two injection probes: a raw <script> and a [x](javascript:…) link
//     (M2: neither becomes a live <script> nor a javascript: href — react-markdown's
//      default, no rehype-raw + url sanitization, holds)
//   - a fenced JSON competitor list to prove parsing (unchanged).
const XSS = "<script>window.__pwned=1</script>";
const ANSWER =
  `Yes! **Rose & Thorn** is a wonderful florist in Leeds. ${XSS} ` +
  "[grab a bouquet](javascript:alert(1))\n\n" +
  "A few reasons customers love it:\n\n- fresh flowers cut daily\n- friendly, warm staff\n\n" +
  'Other good options:\n```json\n["Petal Pushers", "Bloom Room"]\n```';

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let server: RunningServer;
let mailer: ConsoleMailer;
let brain: Server;
let brainUrl: string;

function startMockBrain(): Promise<string> {
  return new Promise((resolve) => {
    brain = createServer((req, res) => {
      if (req.method === "POST" && (req.url ?? "").endsWith("/chat/completions")) {
        // Test-harness only: a small per-call delay so each "Question N of 5…" is
        // reliably observable by Playwright instead of flashing past. Production
        // timing is unchanged — the real brain is slow on its own.
        setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-mock",
            object: "chat.completion",
            created: 0,
            model: "mock-model",
            choices: [{ index: 0, message: { role: "assistant", content: ANSWER }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 },
          }),
        );
        }, 150);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    brain.listen(0, "127.0.0.1", () => {
      const { port } = brain.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
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
  brainUrl = await startMockBrain();
});

test.afterAll(async () => {
  await server?.close();
  await pool?.end();
  await container?.stop();
  brain?.close();
});

test("user checks their AI visibility and sees a score, verbatim answers, competitors + fix-its", async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      SKOVERN_API_URL: server.url,
      SKOVERN_OPENROUTER_BASE_URL: brainUrl,
    },
  });

  try {
    const page = await app.firstWindow();

    // sign in
    await page.getByLabel("Your email").fill("visibility@shop.test");
    await page.getByRole("button", { name: "Send me a link" }).click();
    await expect.poll(() => mailer.sent.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.getByLabel("Paste your link").fill(mailer.sent[mailer.sent.length - 1]!.url);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText(/founding user #1/i)).toBeVisible();

    // connect a brain (default = OpenRouter, pointed at the mock)
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Your key").fill(FAKE_KEY);
    await page.getByRole("button", { name: "Save brain" }).click();
    await expect(page.getByText("Brain saved.")).toBeVisible();

    // open Skills → AI Visibility shows, with its plain-English permission card
    await page.getByRole("button", { name: "Skills" }).click();
    await expect(page.getByRole("heading", { name: "AI Visibility" })).toBeVisible();
    await expect(page.getByText("Use your assistant's brain to think.")).toBeVisible();

    // open the dedicated view and run a check
    await page.getByRole("button", { name: "Open" }).click();
    await page.getByLabel("Your business name").fill("Rose & Thorn");
    await page.getByLabel("What kind of business?").fill("florist");
    await page.getByLabel("Your town or city").fill("Leeds");
    await page.getByRole("button", { name: "Check my visibility" }).click();

    // loop 016: live progress ("Question N of 5…") shows while the run is in flight —
    // proving progress is emitted from the child, survives the sandbox + both process
    // hops, and reaches the view BEFORE the final score renders.
    await expect(page.getByText(/of 5/)).toBeVisible({ timeout: 30_000 });

    // the score WE computed (mentioned in all 5) + the pieces of the result
    await expect(page.getByText("100", { exact: false })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/AI knows you well/)).toBeVisible();
    // exact match → the competitor <li>, not the answer <p>s that quote the JSON
    await expect(page.getByText("Petal Pushers", { exact: true })).toBeVisible();
    await expect(page.getByText(/Google Business Profile|About page/)).toBeVisible(); // a fix-it

    // S2: the <script> in the answer rendered as ESCAPED TEXT (in every answer), never executed
    await expect(page.getByText(XSS).first()).toBeVisible();
    expect(await page.locator(".av-result script").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();

    // M1 — markdown renders as real elements (loop 018): the answer's **bold** and
    // "- " list become <strong>/<li>, and the literal "**" is NOT shown as text.
    const firstAnswer = page.locator(".av-result .answer").first();
    await expect(firstAnswer.locator("strong")).toHaveCount(1);
    expect(await firstAnswer.locator("li").count()).toBeGreaterThan(0);
    expect(await firstAnswer.innerText()).not.toContain("**");

    // M2 — the untrusted answer stays inert: no <script> element and no anchor whose
    // href starts "javascript:" anywhere in the rendered answers.
    expect(await page.locator(".av-result .answer script").count()).toBe(0);
    expect(await page.locator('.av-result .answer a[href^="javascript:"]').count()).toBe(0);

    // a model receipt is on disk — metadata only, no key, no answer body
    const log = readFileSync(path.join(userDataDir, "receipts.jsonl"), "utf8");
    expect(log).toContain('"task":"skill:ai-visibility"');
    expect(log).toContain('"provider":"openrouter"');
    expect(log).not.toContain(FAKE_KEY);
    expect(log).not.toContain("window.__pwned");
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

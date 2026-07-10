import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, expect, it } from "vitest";
import { POSTS } from "../news/posts.js";

// Metric for loop 007: boot the REAL entrypoint and prove a published post has a
// public HTML page with OG tags, an OG image, a clean 404 for unknowns, and —
// the piece deferred since 005 — that a hostile markdown body is neutralized.

const mainPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "main.ts");
const ADMIN_PW = "publish-loop-test-pw";
const SLUG = POSTS[0]!.slug; // a seeded post

let container: StartedPostgreSqlContainer;
let child: ChildProcess;
let output = "";

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
});

afterAll(async () => {
  child?.kill();
  await container?.stop();
});

async function waitFor(re: RegExp, label: string, timeoutMs = 30_000): Promise<RegExpMatchArray> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const m = output.match(re);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}. Server output so far:\n${output}`);
}

function basic(password: string): string {
  return "Basic " + Buffer.from(`admin:${password}`).toString("base64");
}

it("serves published pages with OG cards and sanitizes hostile bodies", async () => {
  child = spawn(process.execPath, ["--import", "tsx", mainPath], {
    env: {
      ...process.env,
      DATABASE_URL: container.getConnectionUri(),
      PORT: "0",
      RESEND_API_KEY: "",
      DESKHAND_ADMIN_TOKEN: ADMIN_PW,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (output += d.toString()));

  const listening = await waitFor(/listening on (http:\/\/127\.0\.0\.1:\d+)/, "listening line");
  const base = listening[1]!;

  // 1. a seeded post has a public HTML page with OG tags
  const page = await fetch(`${base}/u/news/${SLUG}`);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toMatch(/text\/html/);
  const html = await page.text();
  expect(html).toContain(POSTS[0]!.title);
  expect(html).toContain('property="og:title"');
  expect(html).toContain(`/u/news/${SLUG}/og.svg`); // og:image points at the card

  // 2. unknown slug → clean 404 HTML (not a 500)
  const missing = await fetch(`${base}/u/news/nope`);
  expect(missing.status).toBe(404);
  expect(missing.headers.get("content-type")).toMatch(/text\/html/);

  // 2b. a malformed %-escape in the slug is a clean 404, not a 500
  const malformed = await fetch(`${base}/u/news/%`);
  expect(malformed.status).toBe(404);

  // 3. the OG image endpoint returns an image
  const og = await fetch(`${base}/u/news/${SLUG}/og.svg`);
  expect(og.status).toBe(200);
  expect(og.headers.get("content-type")).toMatch(/image\//);

  // 4. THE DEFERRED PIECE: a hostile markdown body must not become live HTML.
  //    Publish a post whose body carries script/img-onerror payloads, then
  //    fetch its page and assert they're rendered inert (escaped), never raw.
  const hostile = 'Hi <script>alert(1)</script> and <img src=x onerror=alert(2)>';
  const published = await fetch(`${base}/admin/news`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: basic(ADMIN_PW) },
    body: JSON.stringify({ slug: "xss-probe", title: "XSS <b>probe</b>", body: hostile }),
  });
  expect(published.status).toBe(200);

  const probe = await fetch(`${base}/u/news/xss-probe`);
  const probeHtml = await probe.text();
  // No raw tag from the body survives — angle brackets are escaped, so neither
  // the script nor the img (and thus its onerror) can ever be live markup.
  expect(probeHtml).not.toContain("<script>");
  expect(probeHtml).not.toContain("<img");
  expect(probeHtml).toContain("&lt;script&gt;alert(1)&lt;/script&gt;"); // escaped, not stripped
  expect(probeHtml).toContain("&lt;img src=x onerror=alert(2)&gt;"); // inert text
  expect(probeHtml).toContain("XSS &lt;b&gt;probe&lt;/b&gt;"); // title escaped too

  child.kill("SIGTERM");
});

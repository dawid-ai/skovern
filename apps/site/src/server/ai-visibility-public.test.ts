import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, expect, it } from "vitest";

// Metric for loop 013b: boot the REAL entrypoint and prove a signed-in user can
// publish an AI Visibility result to a public page — with the untrusted business
// name + competitor names ESCAPED (S2), the score clamped, no secret on the page
// (S5), and the write path gated by a session.

const mainPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "main.ts");

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

async function signIn(base: string, email: string): Promise<string> {
  await fetch(`${base}/auth/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const link = await waitFor(
    new RegExp(`Sign-in link for ${email.replace(/[.@]/g, "\\$&")}:\\s*(\\S+)`),
    "printed magic link",
  );
  const token = new URL(link[1]!).searchParams.get("token")!;
  const res = await fetch(`${base}/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  return ((await res.json()) as { session: string }).session;
}

function publish(base: string, session: string | null, body: unknown): Promise<Response> {
  return fetch(`${base}/publish/visibility`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(session ? { authorization: `Bearer ${session}` } : {}) },
    body: JSON.stringify(body),
  });
}

it("publishes a visibility result to an escaped, secret-free public page (session-gated)", async () => {
  child = spawn(process.execPath, ["--import", "tsx", mainPath], {
    env: { ...process.env, DATABASE_URL: container.getConnectionUri(), PORT: "0", RESEND_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (output += d.toString()));

  const listening = await waitFor(/listening on (http:\/\/127\.0\.0\.1:\d+)/, "listening line");
  const base = listening[1]!;
  const session = await signIn(base, "florist@shop.test");

  // 1. no session → 401 (an outbound publish needs an authenticated owner)
  const anon = await publish(base, null, { business: "X", score: 50, competitors: [] });
  expect(anon.status).toBe(401);

  // 2. publish with hostile strings + an out-of-range score
  const hostileName = 'Rose & Thorn <script>alert(1)</script>';
  const res = await publish(base, session, {
    business: hostileName,
    score: 150, // must clamp to 100
    competitors: ["Petal Pushers", '<img src=x onerror=alert(2)>'],
  });
  expect(res.status).toBe(200);
  const { url, id } = (await res.json()) as { ok: boolean; id: string; url: string };
  expect(url).toContain(`/u/visibility/${id}`);

  // 3. the public page: escaped business + competitor, clamped score, no secret
  const page = await fetch(url);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toMatch(/text\/html/);
  const html = await page.text();
  // S-esc — the hostile business + competitor names are escaped, never live markup.
  expect(html).not.toContain("<script>"); // no live markup from the name
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;script&gt;"); // escaped, not stripped
  expect(html).toContain("Rose &amp; Thorn");
  expect(html).toContain("100/100"); // 150 clamped to 100
  expect(html).toContain('property="og:title"');
  expect(html).toContain(`/u/visibility/${id}/og.png`); // card is a PNG now (loop 018)

  // CSP is still strict: the one inline <style> rides a per-response nonce, NOT
  // 'unsafe-inline', and scripts stay blocked. A regression to unsafe-inline (or a
  // dropped CSP) is a finding.
  const csp = page.headers.get("content-security-policy") ?? "";
  expect(csp).toMatch(/style-src 'nonce-[^']+'/);
  expect(csp).toContain("default-src 'none'");
  expect(csp).not.toContain("unsafe-inline");
  const nonce = /style-src 'nonce-([^']+)'/.exec(csp)?.[1] ?? "";
  expect(nonce.length).toBeGreaterThan(0);
  expect(html).toContain(`<style nonce="${nonce}">`); // the style tag carries that exact nonce

  // S-summary — summary only: the score + competitors are on the page, but NO
  // verbatim AI answers and NO API key ever reach it.
  expect(html).toContain("Petal Pushers"); // a competitor (the summary content)
  expect(html).not.toContain("sk-"); // no OpenAI/OpenRouter-style key
  expect(html).not.toMatch(/answer/i); // no verbatim-answer field leaked onto the page
  expect(html).not.toContain(session); // S5 — the session token never lands on the page
  expect(html).not.toContain("account_id");

  // 4. PNG — the OG card is a real rasterised PNG (satori + resvg), not an SVG.
  const og = await fetch(`${url}/og.png`);
  expect(og.status).toBe(200);
  expect(og.headers.get("content-type")).toBe("image/png");
  const magic = new Uint8Array(await og.arrayBuffer()).subarray(0, 4);
  expect(Array.from(magic)).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes

  // the retired .svg card route is gone → 404, not a stale image
  const staleSvg = await fetch(`${url}/og.svg`);
  expect(staleSvg.status).toBe(404);

  // 5. unknown id → clean 404 (not a 500)
  const missing = await fetch(`${base}/u/visibility/does-not-exist`);
  expect(missing.status).toBe(404);

  // 6. a publish with no business name is rejected
  const noName = await publish(base, session, { business: "  ", score: 40, competitors: [] });
  expect(noName.status).toBe(400);

  child.kill("SIGTERM");
});

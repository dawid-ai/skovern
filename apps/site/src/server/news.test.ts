import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, expect, it } from "vitest";
import { POSTS } from "../news/posts.js";

// Metric for loop 005: boot the REAL standalone entrypoint (env → pool →
// migrate → seed → serve) and prove GET /news is reachable by an ANONYMOUS
// client, newest-first, public fields only.

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

interface NewsPostDto {
  slug: string;
  title: string;
  body: string;
  publishedAt: string;
}

it("serves the seeded news feed to an anonymous client, newest first", async () => {
  child = spawn(process.execPath, ["--import", "tsx", mainPath], {
    env: { ...process.env, DATABASE_URL: container.getConnectionUri(), PORT: "0", RESEND_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (output += d.toString()));

  const listening = await waitFor(/listening on (http:\/\/127\.0\.0\.1:\d+)/, "listening line");
  const base = listening[1]!;

  // 1. GET /news with NO auth header / no session
  const res = await fetch(`${base}/news`);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { ok: boolean; posts: NewsPostDto[] };
  expect(json.ok).toBe(true);

  // 2. every seeded post is present
  const slugs = json.posts.map((p) => p.slug);
  for (const seed of POSTS) expect(slugs).toContain(seed.slug);

  // 3. newest-first by publishedAt
  const dates = json.posts.map((p) => Date.parse(p.publishedAt));
  const sorted = [...dates].sort((a, b) => b - a);
  expect(dates).toEqual(sorted);

  // 4. only public fields ship — no internal columns leak
  const first = json.posts[0]!;
  expect(Object.keys(first).sort()).toEqual(["body", "publishedAt", "slug", "title"]);

  // 5. an unknown path under the feed is a clean 404, not a 500
  const missing = await fetch(`${base}/news/nope`);
  expect(missing.status).toBe(404);
  expect(((await missing.json()) as { ok: boolean }).ok).toBe(false);

  child.kill("SIGTERM");
});

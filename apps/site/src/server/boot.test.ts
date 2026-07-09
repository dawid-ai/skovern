import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, expect, it } from "vitest";

// Metric for loop 004: boot the REAL standalone entrypoint as its own process
// (env → pool → migrate → mailer → serve → shutdown) and drive it over HTTP,
// reading the magic link from the server's own console output.

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

it("boots standalone, serves a real sign-in, and shuts down", async () => {
  child = spawn(process.execPath, ["--import", "tsx", mainPath], {
    env: { ...process.env, DATABASE_URL: container.getConnectionUri(), PORT: "0", RESEND_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (output += d.toString()));

  // 1. it migrated and started listening on its own
  const listening = await waitFor(/listening on (http:\/\/127\.0\.0\.1:\d+)/, "listening line");
  const base = listening[1]!;

  // 2. request a link over real HTTP
  const reqRes = await fetch(`${base}/auth/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "boot@shop.test" }),
  });
  expect(reqRes.status).toBe(200);

  // 3. read the link the server PRINTED to its console (the dev inbox)
  const linkLine = await waitFor(/Sign-in link for boot@shop\.test:\s*(\S+)/, "printed magic link");
  const printed = new URL(linkLine[1]!);
  // the printed link must point at the real bound port, not :0 (F2 regression guard)
  expect(printed.origin).toBe(base);
  const token = printed.searchParams.get("token")!;

  // 4. verify it → founding user #1 comes back through the whole boot path
  const verifyRes = await fetch(`${base}/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  expect(verifyRes.status).toBe(200);
  expect(((await verifyRes.json()) as { ogNumber: number }).ogNumber).toBe(1);

  // 5. it shuts down when asked and frees the process
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  child.kill("SIGTERM");
  const code = await exited;
  // POSIX runs the graceful handler → exit 0; Windows kill is abrupt, so only
  // require that it terminated (real Ctrl+C on Windows still hits the handler).
  if (process.platform !== "win32") expect(code).toBe(0);
});

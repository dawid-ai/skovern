import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";

// Boots the stack W2 drives: Postgres (Testcontainers) → the real api
// (apps/site, dev mailer) → a www build pointed at that api → `astro preview`.
// Returns the teardown. URLs reach the tests through process.env.

const www = join(import.meta.dirname, "..");
const site = join(www, "..", "site");
// A fresh admin password per run; the tests read it from process.env.
const adminPassword = randomBytes(24).toString("hex");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(url: string, label: string, child: ChildProcess, log: () => string): Promise<void> {
  for (let i = 0; i < 240; i += 1) {
    if (child.exitCode !== null) throw new Error(`${label} exited early:\n${log()}`);
    const ok = await fetch(url).then((r) => r.status < 500, () => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${label} never came up at ${url}:\n${log()}`);
}

function start(cmd: string, args: string[], cwd: string, env: Record<string, string>): { child: ChildProcess; log: () => string } {
  let out = "";
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
  return { child, log: () => out };
}

export default async function setup(): Promise<() => Promise<void>> {
  const db = await new PostgreSqlContainer("postgres:17-alpine").start();
  const apiPort = await freePort();
  const wwwPort = await freePort();
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const wwwUrl = `http://127.0.0.1:${wwwPort}`;

  const api = start(process.execPath, ["--import", "tsx", "src/server/main.ts"], site, {
    DATABASE_URL: db.getConnectionUri(),
    PORT: String(apiPort),
    HOST: "127.0.0.1",
    NODE_ENV: "development",
    RESEND_API_KEY: "",
    CORS_ORIGINS: wwwUrl,
    SITE_URL: wwwUrl,
    // Only the no-JS tests send X-Forwarded-For (plain form posts, so no CORS
    // preflight); the JS tests fall back to the socket address.
    TRUST_PROXY: "1",
    SKOVERN_ADMIN_TOKEN: adminPassword,
  });
  await waitFor(`${apiUrl}/healthz`, "api", api.child, api.log);

  const astro = join(www, "node_modules", "astro", "bin", "astro.mjs");
  const built = spawnSync(process.execPath, [astro, "build", "--outDir", "out/e2e"], {
    cwd: www,
    env: { ...process.env, PUBLIC_API_URL: apiUrl },
    encoding: "utf8",
  });
  if (built.status !== 0) throw new Error(`www build failed:\n${built.stdout}${built.stderr}`);

  const preview = start(process.execPath, [astro, "preview", "--outDir", "out/e2e", "--host", "127.0.0.1", "--port", String(wwwPort)], www, {});
  await waitFor(wwwUrl, "astro preview", preview.child, preview.log);

  process.env["WWW_URL"] = wwwUrl;
  process.env["API_URL"] = apiUrl;
  process.env["ADMIN_TOKEN"] = adminPassword;

  return async () => {
    preview.child.kill();
    api.child.kill();
    await db.stop();
  };
}

// The stage the image smoke runs on: a Testcontainers Postgres, a fake Resend
// behind real TLS (production refuses a non-https RESEND_API_URL), and helpers
// to boot the production image against them.
//
// TLS: a Caddy container answers as https://resend.test on a private Docker
// network, with a certificate from Caddy's own throwaway CA, and proxies to the
// fake Resend on the host. The api container trusts that CA through
// NODE_EXTRA_CA_CERTS, copied in before it starts. Nothing is trusted on the host.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

export const IMAGE = process.env["SMOKE_IMAGE"] ?? "skovern-api-smoke";
const CADDY = "caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d";
const HOST_GW = ["--add-host", "host.docker.internal:host-gateway"];

export interface SentEmail { to: string; subject: string; text: string; auth: string | undefined }

export interface Api {
  id: string;
  base: string;
  port: number;
  logs: () => string;
}

export const docker = (args: string[]): string => execFileSync("docker", args, { encoding: "utf8" }).trim();
const envArgs = (env: Record<string, string>): string[] => Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function startHarness(adminToken: string) {
  const sent: SentEmail[] = [];
  const resend = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/emails") {
        const body = JSON.parse(raw) as { to: string; subject: string; text: string };
        // Answer slowly, like a real mail API, so concurrent joins overlap the send.
        setTimeout(() => {
          sent.push({ ...body, auth: req.headers.authorization });
          res.writeHead(200, { "content-type": "application/json" }).end('{"id":"fake"}');
        }, 400);
      } else res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => resend.listen(0, "0.0.0.0", () => r()));
  const resendPort = (resend.address() as AddressInfo).port;

  console.log("Starting Postgres and the TLS front for the fake Resend…");
  const db: StartedPostgreSqlContainer = await new PostgreSqlContainer("postgres:17-alpine").start();
  const net = `skovern-smoke-${process.pid}`;
  docker(["network", "create", net]);
  const caddy = docker([
    "run", "-d", "--network", net, "--network-alias", "resend.test", ...HOST_GW, CADDY,
    "caddy", "reverse-proxy", "--from", "resend.test", "--to", `host.docker.internal:${resendPort}`, "--internal-certs",
  ]);
  const certDir = mkdtempSync(join(tmpdir(), "skovern-smoke-"));
  const caFile = join(certDir, "ca.crt");
  for (let i = 0; ; i += 1) {
    const r = spawnSync("docker", ["exec", caddy, "cat", "/data/caddy/pki/authorities/local/root.crt"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.includes("BEGIN CERTIFICATE")) {
      writeFileSync(caFile, r.stdout);
      break;
    }
    if (i > 80) throw new Error(`Caddy never made its CA:\n${docker(["logs", caddy])}`);
    await sleep(250);
  }

  const baseEnv: Record<string, string> = {
    NODE_ENV: "production",
    APP_URL: "https://api.skovern.com",
    DATABASE_URL: `postgres://${db.getUsername()}:${db.getPassword()}@host.docker.internal:${db.getPort()}/${db.getDatabase()}`,
    RESEND_API_KEY: "re_smoke_key",
    RESEND_API_URL: "https://resend.test",
    SKOVERN_ADMIN_TOKEN: adminToken,
    TRUST_PROXY: "1",
    NODE_EXTRA_CA_CERTS: "/tmp/smoke-ca.crt",
  };
  const containers: string[] = [];

  /** Boot the image once in the foreground (for boot-refusal checks). */
  const runOnce = (env: Record<string, string>): { status: number | null; out: string } => {
    const r = spawnSync("docker", ["run", "--rm", ...HOST_GW, ...envArgs(env), IMAGE], { encoding: "utf8", timeout: 60_000 });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };

  /** Start the image in the background and wait for /healthz. */
  const startApi = async (extra: Record<string, string> = {}): Promise<Api> => {
    const id = docker(["create", "--network", net, ...HOST_GW, "-p", "127.0.0.1::8080", ...envArgs({ ...baseEnv, ...extra }), IMAGE]);
    containers.push(id);
    docker(["cp", caFile, `${id}:/tmp/smoke-ca.crt`]);
    docker(["start", id]);
    const port = Number(docker(["port", id, "8080/tcp"]).split("\n")[0]!.split(":").pop());
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 120; i += 1) {
      if ((await fetch(`${base}/healthz`).then((r) => r.status, () => 0)) === 200) break;
      await sleep(250);
    }
    return { id, base, port, logs: () => spawnSync("docker", ["logs", id], { encoding: "utf8" }).stdout };
  };

  const close = async (): Promise<void> => {
    for (const id of [...containers, caddy]) spawnSync("docker", ["rm", "-f", id]);
    spawnSync("docker", ["network", "rm", net]);
    rmSync(certDir, { recursive: true, force: true });
    await db.stop();
    resend.close();
  };

  return { sent, db, baseEnv, runOnce, startApi, close };
}

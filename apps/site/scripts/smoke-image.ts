// Loop 051 metric: run the PRODUCTION api image (NODE_ENV=production) against a
// Testcontainers Postgres and a fake Resend, and assert S1–S10 over real HTTP.
//
//   docker build -f apps/site/Dockerfile -t skovern-api-smoke .
//   node apps/site/scripts/smoke-image.ts
//
// Plain Node (built-in type stripping), no test runner: each clause prints
// PASS/FAIL and the process exits non-zero on the first failure.
import { execFileSync, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { PostgreSqlContainer } from "@testcontainers/postgresql";

const IMAGE = process.env["SMOKE_IMAGE"] ?? "skovern-api-smoke";
const ADMIN = "smoke-admin-token-0123456789abcdef";
const SITE = "https://skovern.com";

function check(id: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${id}: ${detail}`);
  if (!ok) throw new Error(`${id} failed: ${detail}`);
}

const docker = (args: string[]): string => execFileSync("docker", args, { encoding: "utf8" }).trim();

// --- fake Resend: records every email the image sends --------------------
interface SentEmail { to: string; subject: string; text: string; auth: string | undefined }
const sent: SentEmail[] = [];
const resend = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (c: Buffer) => (raw += c.toString()));
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/emails") {
      const body = JSON.parse(raw) as { to: string; subject: string; text: string };
      sent.push({ ...body, auth: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/json" }).end('{"id":"fake"}');
    } else res.writeHead(404).end();
  });
});
await new Promise<void>((r) => resend.listen(0, "0.0.0.0", () => r()));
const resendPort = (resend.address() as AddressInfo).port;

console.log("Starting Postgres…");
const db = await new PostgreSqlContainer("postgres:17-alpine").start();
const dbUrlFromImage = `postgres://${db.getUsername()}:${db.getPassword()}@host.docker.internal:${db.getPort()}/${db.getDatabase()}`;

const baseEnv: Record<string, string> = {
  NODE_ENV: "production",
  APP_URL: "https://api.skovern.com",
  DATABASE_URL: dbUrlFromImage,
  RESEND_API_KEY: "re_smoke_key",
  RESEND_API_URL: `http://host.docker.internal:${resendPort}`,
  SKOVERN_ADMIN_TOKEN: ADMIN,
  TRUST_PROXY: "1",
};
const envArgs = (env: Record<string, string>): string[] => Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
const HOST_GW = ["--add-host", "host.docker.internal:host-gateway"];

let container = "";
try {
  // S2: a production boot without each required setting fails, naming it.
  for (const key of ["RESEND_API_KEY", "APP_URL", "DATABASE_URL"]) {
    const env = { ...baseEnv };
    delete env[key];
    const r = spawnSync("docker", ["run", "--rm", ...HOST_GW, ...envArgs(env), IMAGE], { encoding: "utf8", timeout: 60_000 });
    const out = `${r.stdout}${r.stderr}`;
    check("S2", r.status !== 0 && out.includes(key), `boot without ${key} exits ${r.status} and names it`);
  }

  // S1: boots and answers /healthz.
  container = docker(["run", "-d", ...HOST_GW, "-p", "127.0.0.1::8080", ...envArgs(baseEnv), IMAGE]);
  const port = docker(["port", container, "8080/tcp"]).split("\n")[0]!.split(":").pop()!;
  const base = `http://127.0.0.1:${port}`;
  let health = 0;
  for (let i = 0; i < 120 && health !== 200; i += 1) {
    health = await fetch(`${base}/healthz`).then((r) => r.status, () => 0);
    if (health !== 200) await new Promise((r) => setTimeout(r, 250));
  }
  check("S1", health === 200, `GET /healthz → ${health}`);

  let ipN = 0;
  const ip = (): string => `203.0.113.${(ipN += 1)}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip(), origin: SITE, ...headers },
      body: JSON.stringify(body),
    });

  // S3: signup → number + welcome email with a remove link → details save → repeat is idempotent.
  const j1 = await post("/api/waitlist", { name: "Rosa", email: "rosa@bloom.test" });
  const a = (await j1.json()) as { number: number; detailsToken: string };
  const mail = sent[0];
  const removeUrl = mail?.text.match(/https:\/\/api\.skovern\.com\/waitlist\/remove\?t=[\w-]{43}/)?.[0];
  check("S3", j1.status === 201 && a.number === 1, `step 1 → ${j1.status} #${a.number}`);
  check("S3", mail?.to === "rosa@bloom.test" && mail.auth === "Bearer re_smoke_key" && !!removeUrl, "welcome reached fake Resend with a remove link");
  const det = await post("/api/waitlist/details", { detailsToken: a.detailsToken, jobTitle: "Owner", businessType: "florist", url: "bloom.test" });
  check("S3", det.status === 204, `details saved → ${det.status}`);
  const j2 = await post("/api/waitlist", { name: "Rosa", email: "ROSA@bloom.test" });
  const b = (await j2.json()) as { number: number };
  check("S3", j2.status === 201 && b.number === 1 && sent.length === 1, `repeat → #${b.number}, emails sent ${sent.length}`);

  // S4: each bad input is rejected with its own reason.
  const reject = async (path: string, body: unknown, field: string, label: string): Promise<void> => {
    const r = await post(path, body);
    const j = (await r.json()) as { field?: string; message?: string };
    check("S4", r.status === 400 && j.field === field && !!j.message, `${label} → ${r.status} ${j.field}: ${j.message}`);
  };
  await reject("/api/waitlist", { name: "Rosa", email: "rosa@" }, "email", "bad email");
  await reject("/api/waitlist", { name: "x".repeat(81), email: "x@bloom.test" }, "name", "81-char name");
  await reject("/api/waitlist/details", { detailsToken: a.detailsToken, url: "javascript:alert(1)" }, "url", "javascript: URL");
  await reject("/api/waitlist/details", { detailsToken: a.detailsToken, businessType: "casino" }, "businessType", "unknown business type");
  const pool = new pg.Pool({ connectionString: db.getConnectionUri() });
  await pool.query(`UPDATE waitlist_tokens SET expires_at = now() - interval '1 minute' WHERE kind = 'details'`);
  await reject("/api/waitlist/details", { detailsToken: a.detailsToken, jobTitle: "Owner" }, "detailsToken", "expired token");

  // S7 (+ S4 reused-after-remove): GET shows a button only; POST deletes; the old token is dead.
  const lee = (await (await post("/api/waitlist", { name: "Lee", email: "lee@bakery.test" })).json()) as { detailsToken: string };
  const leeLink = sent.at(-1)?.text.match(/remove\?t=([\w-]{43})/)?.[1] ?? "";
  const g = await fetch(`${base}/waitlist/remove?t=${leeLink}`);
  const count = async (): Promise<number> => Number((await pool.query(`SELECT count(*) AS n FROM waitlist`)).rows[0].n);
  check("S7", g.status === 200 && (await g.text()).includes("Remove me") && (await count()) === 2, "GET shows a confirm button and deletes nothing");
  const p = await fetch(`${base}/waitlist/remove`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip() },
    body: `t=${leeLink}`,
  });
  check("S7", p.status === 200 && (await count()) === 1, `POST deletes → ${p.status}, rows left ${await count()}`);
  await reject("/api/waitlist/details", { detailsToken: lee.detailsToken, jobTitle: "Baker" }, "detailsToken", "token reused after remove");

  // S5: CORS only for the two skovern.com origins.
  for (const origin of ["https://skovern.com", "https://www.skovern.com", "https://evil.test", "http://skovern.com"]) {
    const r = await fetch(`${base}/api/waitlist`, { method: "OPTIONS", headers: { origin } });
    const acao = r.headers.get("access-control-allow-origin");
    const want = origin.startsWith("https://") && origin.endsWith("skovern.com");
    check("S5", want ? acao === origin : acao === null, `${origin} → ACAO ${acao ?? "(none)"}`);
  }

  // S6: 429 past the limit; rotating the client-supplied XFF prefix doesn't help.
  const flood = async (path: string, body: unknown, n: number): Promise<number[]> => {
    const out: number[] = [];
    for (let i = 0; i < n; i += 1) {
      out.push((await post(path, body, { "x-forwarded-for": `10.0.${i}.1, 198.51.100.77` })).status);
    }
    return out;
  };
  const wl = await flood("/api/waitlist", { name: "", email: "" }, 10);
  check("S6", wl.slice(-2).every((s) => s === 429) && !wl.slice(0, 8).includes(429), `/api/waitlist statuses ${wl.join(",")}`);
  const au = await flood("/auth/request", { email: "x@bloom.test" }, 8);
  check("S6", au.slice(-2).every((s) => s === 429) && !au.slice(0, 6).includes(429), `/auth/request statuses ${au.join(",")}`);

  // S8: admin auth + CSV formula neutralization.
  await post("/api/waitlist", { name: "=HYPERLINK(\"http://x\")", email: "csv@bloom.test" });
  const noAuth = await fetch(`${base}/admin/waitlist`);
  const basic = { authorization: `Basic ${Buffer.from(`dawid:${ADMIN}`).toString("base64")}` };
  const withAuth = await fetch(`${base}/admin/waitlist`, { headers: basic });
  check("S8", noAuth.status === 401 && withAuth.status === 200, `admin without token ${noAuth.status}, with ${withAuth.status}`);
  const csv = await (await fetch(`${base}/admin/waitlist.csv`, { headers: basic })).text();
  check("S8", csv.includes(`"'=HYPERLINK(""http://x"")"`) && !/(^|,)"=/m.test(csv), "CSV prefixes the formula with '");

  // S9: the OG card renders inside the image (resvg native + bundled font) and caches.
  await pool.query(
    `INSERT INTO published_visibility (id, account_id, business, score, competitors) VALUES ('smoke1', 'acct', 'Bloom & Vine', 72, '["Petal Co"]')`,
  );
  const og1 = await fetch(`${base}/u/visibility/smoke1/og.png`);
  const png = Buffer.from(await og1.arrayBuffer());
  const og2 = await fetch(`${base}/u/visibility/smoke1/og.png`);
  check("S9", og1.status === 200 && png.subarray(1, 4).toString() === "PNG" && png.length > 5000, `og.png ${og1.status}, ${png.length} bytes`);
  check("S9", og1.headers.get("x-skovern-cache") === "miss" && og2.headers.get("x-skovern-cache") === "hit", "second hit served from cache");
  await pool.end();

  // S10: SIGTERM drains and exits within 10 s, even with an idle keep-alive socket open.
  const sock = connect(Number(port), "127.0.0.1");
  await new Promise<void>((r) => sock.once("connect", () => r()));
  sock.write(`GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n`);
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  docker(["stop", "-t", "15", container]);
  const took = (Date.now() - t0) / 1000;
  const code = docker(["inspect", container, "--format", "{{.State.ExitCode}}"]);
  sock.destroy();
  check("S10", took < 10 && code === "0", `stopped in ${took.toFixed(1)} s, exit ${code}`);
  console.log("\nAll smoke clauses passed.");
} catch (err) {
  if (container) console.error(spawnSync("docker", ["logs", container], { encoding: "utf8" }).stdout);
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  if (container) spawnSync("docker", ["rm", "-f", container]);
  await db.stop();
  resend.close();
}

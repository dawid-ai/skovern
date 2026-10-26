// Loop 051 metric: run the PRODUCTION api image (NODE_ENV=production) against a
// Testcontainers Postgres and a fake Resend over TLS, and assert S1–S13 (S13:
// the image's file permissions). The stage (containers, TLS front) is in
// smoke/harness.ts.
//
//   docker build -f apps/site/Dockerfile -t skovern-api-smoke .
//   node apps/site/scripts/smoke-image.ts
//
// Plain Node (built-in type stripping), no test runner: each clause prints
// PASS/FAIL and the process exits non-zero on the first failure.
import { connect } from "node:net";
import pg from "pg";
import { docker, IMAGE, startHarness, type Api } from "./smoke/harness.ts";

const ADMIN = "smoke-admin-token-0123456789abcdef";
const SITE = "https://skovern.com";

function check(id: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${id}: ${detail}`);
  if (!ok) throw new Error(`${id} failed: ${detail}`);
}

const h = await startHarness(ADMIN);
const { sent } = h;
let api: Api | undefined;
let accounts: Api | undefined;
const pool = new pg.Pool({ connectionString: h.db.getConnectionUri() });
pool.on("error", () => {});
try {
  // S2: a production boot without each required setting, or with an unsafe one, fails and names it.
  const refusals: [string, Record<string, string>][] = [
    ["RESEND_API_KEY", { RESEND_API_KEY: "" }],
    ["APP_URL", { APP_URL: "" }],
    ["DATABASE_URL", { DATABASE_URL: "" }],
    ["RESEND_API_URL", { RESEND_API_URL: "http://resend.test" }],
    ["SKOVERN_ADMIN_TOKEN", { SKOVERN_ADMIN_TOKEN: "too-short" }],
  ];
  for (const [key, change] of refusals) {
    const r = h.runOnce({ ...h.baseEnv, ...change });
    check("S2", r.status !== 0 && r.out.includes(key), `boot with bad ${key} exits ${r.status} and names it`);
  }

  // S1: boots (account routes off, the production default) and answers /healthz.
  api = await h.startApi();
  const base = api.base;
  check("S1", (await fetch(`${base}/healthz`)).status === 200, "GET /healthz → 200");

  // S13: the server runs as node and can't write its own code or dependencies.
  const who = docker(["run", "--rm", "--entrypoint", "sh", IMAGE, "-c",
    "id -un; for f in /app/src/x /app/node_modules/x /app/package.json; do touch $f 2>/dev/null && echo WRITABLE $f; done; echo done"]);
  const user = who.split(/\r?\n/)[0] ?? "";
  check("S13", user === "node" && !who.includes("WRITABLE"), `runs as ${user}, /app read-only: ${!who.includes("WRITABLE")}`);

  let ipN = 0;
  const ip = (): string => `203.0.113.${(ipN += 1)}`;
  const postTo = (b: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${b}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip(), origin: SITE, ...headers },
      body: JSON.stringify(body),
    });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> => postTo(base, path, body, headers);

  // S3: signup → number + welcome email (over TLS) with a remove link → details save → repeat is idempotent.
  const j1 = await post("/api/waitlist", { name: "Rosa", email: "rosa@bloom.test" });
  const a = (await j1.json()) as { number: number; detailsToken: string };
  const mail = sent[0];
  const removeUrl = mail?.text.match(/https:\/\/api\.skovern\.com\/waitlist\/remove\?t=[\w-]{43}/)?.[0];
  check("S3", j1.status === 201 && a.number === 1, `step 1 → ${j1.status} #${a.number}`);
  check("S3", mail?.to === "rosa@bloom.test" && mail.auth === "Bearer re_smoke_key" && !!removeUrl, "welcome reached fake Resend over https with a remove link");
  check("S3", mail?.text.startsWith("Hi Rosa,\n") === true, "the welcome greets with the first name only");
  const det = await post("/api/waitlist/details", { detailsToken: a.detailsToken, jobTitle: "Owner", businessType: "florist", url: "bloom.test" });
  check("S3", det.status === 204, `details saved → ${det.status}`);
  const j2 = await post("/api/waitlist", { name: "Rosa", email: "ROSA@bloom.test" });
  const b = (await j2.json()) as { number: number; detailsToken: string };
  check("S3", j2.status === 201 && b.number === 1 && sent.length === 1, `repeat → #${b.number}, emails sent ${sent.length}`);
  const race = await Promise.all([1, 2].map(() => post("/api/waitlist", { name: "Kim", email: "race@bloom.test" }).then((r) => r.json() as Promise<{ number: number }>)));
  const raceMails = sent.filter((m) => m.to === "race@bloom.test").length;
  check("S3", race[0]!.number === race[1]!.number && raceMails === 1, `two joins at once → #${race[0]!.number}/#${race[1]!.number}, ${raceMails} welcome`);
  const decoy = await post("/api/waitlist/details", { detailsToken: b.detailsToken, jobTitle: "PWNED", url: "evil.test" });
  const kept = (await pool.query(`SELECT job_title, url FROM waitlist WHERE email = 'rosa@bloom.test'`)).rows[0] as { job_title: string; url: string };
  check("S3", decoy.status === 204 && kept.job_title === "Owner" && kept.url === "https://bloom.test", `a repeat join's token saves nothing (${decoy.status}, ${kept.job_title}, ${kept.url})`);

  // S4: each bad input is rejected with its own reason.
  const reject = async (path: string, body: unknown, field: string, label: string): Promise<void> => {
    const r = await post(path, body);
    const j = (await r.json()) as { field?: string; message?: string };
    check("S4", r.status === 400 && j.field === field && !!j.message, `${label} → ${r.status} ${j.field}: ${j.message}`);
  };
  await reject("/api/waitlist", { name: "Rosa", email: "rosa@" }, "email", "bad email");
  await reject("/api/waitlist", { name: "x".repeat(81), email: "x@bloom.test" }, "name", "81-char name");
  await reject("/api/waitlist", { name: "Win <a href=x>cash</a>", email: "x@bloom.test" }, "name", "markup in the name");
  await reject("/api/waitlist", { name: "Claim at Refund.ICU", email: "x@bloom.test" }, "name", "domain in the name");
  await reject("/api/waitlist", { name: "Pay at x.bond today", email: "x@bloom.test" }, "name", "one-letter domain in the name");
  await reject("/api/waitlist/details", { detailsToken: a.detailsToken, url: "javascript:alert(1)" }, "url", "javascript: URL");
  await reject("/api/waitlist/details", { detailsToken: a.detailsToken, businessType: "casino" }, "businessType", "unknown business type");
  await pool.query(`UPDATE waitlist_tokens SET expires_at = now() - interval '1 minute' WHERE kind = 'details'`);
  await reject("/api/waitlist/details", { detailsToken: a.detailsToken, jobTitle: "Owner" }, "detailsToken", "expired token");

  // S7 (+ S4 reused-after-remove): GET shows a button only; POST deletes; the old token is dead.
  const lee = (await (await post("/api/waitlist", { name: "Lee", email: "lee@bakery.test" })).json()) as { detailsToken: string };
  const leeLink = sent.at(-1)?.text.match(/remove\?t=([\w-]{43})/)?.[1] ?? "";
  const g = await fetch(`${base}/waitlist/remove?t=${leeLink}`);
  const count = async (): Promise<number> => Number((await pool.query(`SELECT count(*) AS n FROM waitlist WHERE email = 'lee@bakery.test'`)).rows[0].n);
  check("S7", g.status === 200 && (await g.text()).includes("Remove me") && (await count()) === 1, "GET shows a confirm button and deletes nothing");
  const p = await fetch(`${base}/waitlist/remove`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip() },
    body: `t=${leeLink}`,
  });
  check("S7", p.status === 200 && (await count()) === 0, `POST deletes → ${p.status}, Lee's rows left ${await count()}`);
  await reject("/api/waitlist/details", { detailsToken: lee.detailsToken, jobTitle: "Baker" }, "detailsToken", "token reused after remove");

  // S5: CORS only for the two skovern.com origins.
  for (const origin of ["https://skovern.com", "https://www.skovern.com", "https://evil.test", "http://skovern.com"]) {
    const r = await fetch(`${base}/api/waitlist`, { method: "OPTIONS", headers: { origin } });
    const acao = r.headers.get("access-control-allow-origin");
    const want = origin.startsWith("https://") && origin.endsWith("skovern.com");
    check("S5", want ? acao === origin : acao === null, `${origin} → ACAO ${acao ?? "(none)"}`);
  }

  // S12: a foreign Origin is refused on the JSON and form paths; non-JSON bodies get 415.
  const foreignJson = await post("/api/waitlist", { name: "Eve", email: "eve@evil.test" }, { origin: "https://evil.test" });
  const foreignForm = await fetch(`${base}/api/waitlist`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.test", "x-forwarded-for": ip() },
    body: "name=Eve&email=eve%40evil.test",
  });
  check("S12", foreignJson.status === 403 && foreignForm.status === 403, `foreign Origin → JSON ${foreignJson.status}, form ${foreignForm.status}`);
  const plain = await post("/api/waitlist", { name: "Tim", email: "tim@bloom.test" }, { "content-type": "text/plain" });
  check("S12", plain.status === 415, `text/plain → ${plain.status}`);

  // S6: 429 past the limit (3 per 10 minutes); rotating the client-supplied XFF prefix doesn't help.
  const flood = async (b: string, path: string, body: unknown, n: number): Promise<number[]> => {
    const out: number[] = [];
    for (let i = 0; i < n; i += 1) {
      out.push((await postTo(b, path, body, { "x-forwarded-for": `10.0.${i}.1, 198.51.100.77` })).status);
    }
    return out;
  };
  const wl = await flood(base, "/api/waitlist", { name: "", email: "" }, 5);
  check("S6", wl.slice(-2).every((s) => s === 429) && !wl.slice(0, 3).includes(429), `/api/waitlist statuses ${wl.join(",")}`);

  // S8: admin auth + CSV formula neutralization.
  const csvJoin = (await (await post("/api/waitlist", { name: "Csv", email: "csv@bloom.test" })).json()) as { detailsToken: string };
  await post("/api/waitlist/details", { detailsToken: csvJoin.detailsToken, jobTitle: "=HYPERLINK(\"http://x\")" });
  const noAuth = await fetch(`${base}/admin/waitlist`);
  const basic = { authorization: `Basic ${Buffer.from(`dawid:${ADMIN}`).toString("base64")}` };
  const withAuth = await fetch(`${base}/admin/waitlist`, { headers: basic });
  check("S8", noAuth.status === 401 && withAuth.status === 200, `admin without token ${noAuth.status}, with ${withAuth.status}`);
  const csv = await (await fetch(`${base}/admin/waitlist.csv`, { headers: basic })).text();
  check("S8", csv.includes(`"'=HYPERLINK(""http://x"")"`) && !/(^|,)"=/m.test(csv), "CSV prefixes the formula with '");

  // S11: before the beta, production mounts only the waitlist. Every account route is a 404.
  const gone: [string, string][] = [
    ["POST", "/auth/request"], ["POST", "/auth/verify"], ["POST", "/dm"], ["GET", "/dm/thread"], ["POST", "/dm/read"],
    ["POST", "/publish/visibility"], ["GET", "/u/visibility/smoke1/og.png"], ["GET", "/u/news/x"], ["GET", "/news"],
    ["GET", "/admin/dm"], ["POST", "/admin/dm/reply"], ["POST", "/admin/news"],
  ];
  for (const [method, path] of gone) {
    const r = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
    check("S11", r.status === 404, `${method} ${path} → ${r.status}`);
  }

  // With ACCOUNT_ROUTES=1 (the beta), the same image serves them, rate-limited.
  accounts = await h.startApi({ ACCOUNT_ROUTES: "1" });
  const au = await flood(accounts.base, "/auth/request", { email: "x@bloom.test" }, 8);
  check("S6", au.slice(-2).every((s) => s === 429) && !au.slice(0, 6).includes(429), `/auth/request statuses ${au.join(",")}`);

  // S9: the OG card renders inside the image (resvg native + bundled font) and caches.
  await pool.query(
    `INSERT INTO published_visibility (id, account_id, business, score, competitors) VALUES ('smoke1', 'acct', 'Bloom & Vine', 72, '["Petal Co"]')`,
  );
  const og1 = await fetch(`${accounts.base}/u/visibility/smoke1/og.png`);
  const png = Buffer.from(await og1.arrayBuffer());
  const og2 = await fetch(`${accounts.base}/u/visibility/smoke1/og.png`);
  check("S9", og1.status === 200 && png.subarray(1, 4).toString() === "PNG" && png.length > 5000, `og.png ${og1.status}, ${png.length} bytes`);
  check("S9", og1.headers.get("x-skovern-cache") === "miss" && og2.headers.get("x-skovern-cache") === "hit", "second hit served from cache");

  // S10: SIGTERM drains and exits within 10 s, even with an idle keep-alive socket open.
  const sock = connect(api.port, "127.0.0.1");
  await new Promise<void>((r) => sock.once("connect", () => r()));
  sock.write(`GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n`);
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  docker(["stop", "-t", "15", api.id]);
  const took = (Date.now() - t0) / 1000;
  const code = docker(["inspect", api.id, "--format", "{{.State.ExitCode}}"]);
  sock.destroy();
  check("S10", took < 10 && code === "0", `stopped in ${took.toFixed(1)} s, exit ${code}`);
  console.log("\nAll smoke clauses passed.");
} catch (err) {
  for (const c of [api, accounts]) if (c) console.error(c.logs());
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
  await h.close();
}


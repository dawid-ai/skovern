// Hand-validation after deploy (not part of the loop metric): a subset of the
// image smoke (S1, S3, S5, S7) against the live api.
//
//   1. node apps/site/scripts/smoke-prod.ts https://api.skovern.com you+smoke@example.com
//        Signs up that address (one you can read) and checks health, the number,
//        and CORS. It uses up one waitlist number for good: numbers never repeat.
//   2. Open that welcome email, copy its remove link, then:
//      node apps/site/scripts/smoke-prod.ts https://api.skovern.com --remove "<link>"
//        Checks GET only shows the button, then POST removes the test address.
//
// Set SKOVERN_ADMIN_TOKEN in the environment to also confirm the row through
// /admin/waitlist.csv. The token is read from the environment, never printed.

const [base = "", second = "", link] = process.argv.slice(2);
const removing = second === "--remove";
if (!/^https:\/\/[^/]+$/.test(base) || (removing ? !link : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(second))) {
  console.error("Usage: node smoke-prod.ts https://api.skovern.com <test address you can read>");
  console.error("       node smoke-prod.ts https://api.skovern.com --remove <link from the welcome email>");
  process.exit(2);
}
const admin = process.env["SKOVERN_ADMIN_TOKEN"];

function check(id: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${id}: ${detail}`);
  if (!ok) process.exitCode = 1;
}

async function listed(email: string): Promise<boolean | null> {
  if (!admin) return null;
  const r = await fetch(`${base}/admin/waitlist.csv`, {
    headers: { authorization: `Basic ${Buffer.from(`smoke:${admin}`).toString("base64")}` },
  });
  return (await r.text()).includes(`"${email}"`);
}

if (removing) {
  const url = new URL(link ?? "");
  const t = url.searchParams.get("t") ?? "";
  const g = await fetch(`${base}/waitlist/remove?t=${encodeURIComponent(t)}`);
  check("S7", g.status === 200 && (await g.text()).includes("Remove me"), `GET remove page → ${g.status}`);
  const p = await fetch(`${base}/waitlist/remove`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `t=${encodeURIComponent(t)}`,
  });
  check("S7", p.status === 200 && (await p.text()).includes("off the list"), `POST remove → ${p.status}`);
} else {
  const h = await fetch(`${base}/healthz`);
  check("S1", h.status === 200, `GET /healthz → ${h.status}`);
  const email = second;
  const r = await fetch(`${base}/api/waitlist`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://skovern.com" },
    body: JSON.stringify({ name: "Smoke test", email }),
  });
  const j = (await r.json()) as { number?: number };
  check("S3", r.status === 201 && typeof j.number === "number", `signup ${email} → ${r.status} #${j.number}`);
  check("S5", r.headers.get("access-control-allow-origin") === "https://skovern.com", "CORS allows skovern.com");
  const evil = await fetch(`${base}/api/waitlist`, { method: "OPTIONS", headers: { origin: "https://evil.test" } });
  check("S5", evil.headers.get("access-control-allow-origin") === null, "CORS refuses other origins");
  const isListed = await listed(email);
  if (isListed !== null) check("S3", isListed, "the admin CSV lists the test address");
  console.log(`\nNext: open the welcome email at ${email}, copy the remove link, and run with --remove "<link>".`);
}

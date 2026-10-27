// Loop 052 metric, image half: F1–F7 against the production image, with the
// fake Resend (over TLS) serving the Receiving API. Signs webhooks the way Svix
// does, independently of the code under test.
import { createHmac } from "node:crypto";
import type pg from "pg";
import type { Api, startHarness } from "./harness.ts";

type Harness = Awaited<ReturnType<typeof startHarness>>;
type Check = (id: string, ok: boolean, detail: string) => void;

const HOOK = "/hooks/resend/inbound";
const KEY = Buffer.from("smoke-inbox-signing-key-0123456789");
const FORWARD_TO = "dawid@inbox.test";
const id = (n: number): string => `52000000-0000-4000-8000-00000000000${n}`;

let seq = 0;
function signed(body: string, o: { svixId?: string; at?: number; key?: Buffer } = {}): Record<string, string> {
  const svixId = o.svixId ?? `msg_smoke${(seq += 1)}`;
  const ts = String(Math.floor((o.at ?? Date.now()) / 1000));
  const sig = createHmac("sha256", o.key ?? KEY).update(`${svixId}.${ts}.${body}`).digest("base64");
  return { "svix-id": svixId, "svix-timestamp": ts, "svix-signature": `v1,${sig}` };
}
const event = (emailId: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: "email.received", created_at: "2026-10-27T10:00:00.000Z", data: { email_id: emailId, ...extra } });
const received = (emailId: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  object: "email", id: emailId, from: "Rosa <rosa@bloom.test>", to: ["hi@skovern.com"], cc: [], bcc: [], reply_to: [],
  subject: "Do you do weddings?", text: "June 14, about 80 people.", html: "<p>June 14, about 80 people.</p>",
  headers: {}, authentication: { spf: "pass", dkim: "pass", dmarc: "pass" }, attachments: [], ...over,
});

export async function inboxClauses(h: Harness, check: Check, baseWithoutSecret: string, pool: pg.Pool): Promise<Api> {
  /** Post to the webhook, then wait (up to 15 s) until the email it names is settled. */
  const post = async (base: string, body: string, headers: Record<string, string>): Promise<Response> => {
    const r = await fetch(`${base}${HOOK}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
    const emailId = (JSON.parse(body) as { data: { email_id: string } }).data.email_id;
    for (let i = 0; i < 60 && r.status === 200 && (await outcome(emailId)) === "pending"; i += 1) await new Promise((w) => setTimeout(w, 250));
    return r;
  };
  const outcome = async (emailId: string): Promise<string | undefined> =>
    (await pool.query<{ outcome: string }>(`SELECT outcome FROM inbox_mail WHERE email_id = $1`, [emailId])).rows[0]?.outcome;

  // F6: the image without RESEND_WEBHOOK_SECRET doesn't mount the route.
  const unmounted = await post(baseWithoutSecret, event(id(1)), signed(event(id(1))));
  check("F6", unmounted.status === 404, `no secret → ${unmounted.status}`);

  const api = await h.startApi({
    RESEND_WEBHOOK_SECRET: `whsec_${KEY.toString("base64")}`,
    FORWARD_TO,
    FORWARD_MAX_PER_DAY: "3",
  });
  const sentBefore = h.sent.length;
  const forwards = (): typeof h.sent => h.sent.slice(sentBefore);

  // F2: every unsigned or altered delivery is a 401 and sends nothing.
  h.inbound.set(id(1), received(id(1), {
    attachments: [{ id: "a1", filename: "quote.pdf", content_type: "application/pdf", content_disposition: "attachment", content_id: null, size: 1200 }],
  }));
  const body1 = event(id(1));
  const good = signed(body1);
  const refusals: [string, Record<string, string>, string][] = [
    ["bad signature", signed(body1, { key: Buffer.from("not-the-key") }), body1],
    ["missing header", { "svix-id": good["svix-id"]!, "svix-timestamp": good["svix-timestamp"]! }, body1],
    ["6 minutes stale", signed(body1, { at: Date.now() - 6 * 60_000 }), body1],
    ["tampered body", good, body1.replace(id(1), id(9))],
  ];
  for (const [label, headers, body] of refusals) {
    const r = await post(api.base, body, headers);
    check("F2", r.status === 401, `${label} → ${r.status}`);
  }
  check("F2", forwards().length === 0 && h.fetched.length === 0, `after refusals: ${forwards().length} sends, ${h.fetched.length} fetches`);

  // F1: a signed email.received is forwarded over TLS, attachments kept.
  const f1 = await post(api.base, body1, good);
  const fwd = forwards()[0];
  check("F1", f1.status === 200 && forwards().length === 1, `signed → ${f1.status}, sends ${forwards().length}`);
  check("F1", fwd?.to === FORWARD_TO && fwd.from === "Skovern inbox <inbox@in.skovern.com>" && fwd.auth === "Bearer re_smoke_key", "to FORWARD_TO from inbox@in.skovern.com");
  check("055-S4", fwd?.headers?.["Auto-Submitted"] === "auto-generated", `forward marked Auto-Submitted: ${fwd?.headers?.["Auto-Submitted"]}`);
  check("F1", fwd?.key === `forward/${id(1)}` && (await outcome(id(1))) === "forwarded", `Idempotency-Key ${fwd?.key}`);
  check("F1", fwd?.reply_to === "rosa@bloom.test" && fwd.subject === "[skovern.com] Do you do weddings?", `Reply-To ${fwd?.reply_to}, subject "${fwd?.subject}"`);
  check("F1", fwd?.attachments?.[0]?.path === "https://inbound-cdn.test/a1" && fwd.text.includes("To: hi@skovern.com"), "attachment kept, original To at the top");

  // B2: a flood of badly signed requests from one address doesn't lock it out.
  const flood = { "x-forwarded-for": "198.51.100.200" };
  let bad = 0;
  for (let i = 0; i < 25; i += 1) bad += (await post(api.base, body1, { ...signed(body1, { key: Buffer.from("x") }), ...flood })).status === 401 ? 1 : 0;
  const after = await post(api.base, body1, { ...signed(body1), ...flood });
  check("B2", bad === 25 && after.status === 200 && forwards().length === 1, `25 bad → 401 x${bad}, then a valid one → ${after.status}`);

  // F3: the same delivery again is a 200 and no second forward.
  const replay = await post(api.base, body1, good);
  const flagged = ((await replay.json()) as { duplicate?: boolean }).duplicate === true;
  check("F3", replay.status === 200 && flagged && forwards().length === 1, `replay → ${replay.status}, duplicate ${flagged}, sends ${forwards().length}`);

  // F5: mail from our own domain is never forwarded.
  h.inbound.set(id(2), received(id(2), { from: "Skovern <hi@skovern.com>" }));
  const own = await post(api.base, event(id(2)), signed(event(id(2))));
  check("F5", own.status === 200 && forwards().length === 1, `from @skovern.com → ${own.status}, sends ${forwards().length}`);

  // F7: the webhook body's sender, subject, and recipients are ignored.
  h.inbound.set(id(3), received(id(3), { subject: "From the API" }));
  const body3 = event(id(3), { from: "boss@bank.test", to: ["evil@attacker.test"], subject: "From the webhook", text: "pwned" });
  const f7 = await post(api.base, body3, signed(body3));
  const third = forwards()[1];
  check("F7", f7.status === 200 && h.fetched.includes(`/emails/receiving/${id(3)}?html_format=cid`), "fetched by ID from the Receiving API");
  check("F7", third?.to === FORWARD_TO && third.subject === "[skovern.com] From the API" && !/attacker|pwned|bank\.test/.test(JSON.stringify(third)), `subject "${third?.subject}"`);

  // S3: possibly spoofed mail (no SPF or DKIM pass) is forwarded flagged [spam?],
  // on its own cap, not a main forward slot.
  h.inbound.set(id(7), received(id(7), { subject: "Pay this", authentication: { spf: "gray", dkim: "fail", dmarc: "gray" } }));
  const spam = await post(api.base, event(id(7)), signed(event(id(7))));
  const flaggedSent = forwards().filter((m) => m.subject === "[spam?] [skovern.com] Pay this").length;
  check("055-S3", spam.status === 200 && (await outcome(id(7))) === "forwarded" && flaggedSent === 1, `spoofed → ${await outcome(id(7))}, flagged sends ${flaggedSent}`);

  // N1: a failed fetch leaves the email pending, and the next run forwards it once.
  h.resend.getFaults = [503];
  h.inbound.set(id(6), received(id(6), { subject: "Retry me" }));
  const r6 = await fetch(`${api.base}${HOOK}`, { method: "POST", headers: { "content-type": "application/json", ...signed(event(id(6))) }, body: event(id(6)) });
  // Settled for a retry: tried once, and waiting the one-minute retry delay
  // (shorter than the two-minute lease taken while trying).
  const waiting = async (): Promise<boolean> =>
    (await pool.query(
      `SELECT 1 FROM inbox_mail WHERE email_id = $1 AND attempts >= 1 AND next_try < now() + interval '90 seconds'`,
      [id(6)],
    )).rowCount === 1;
  for (let i = 0; i < 60 && !(await waiting()); i += 1) await new Promise((w) => setTimeout(w, 250));
  const firstTry = await outcome(id(6));
  await pool.query(`UPDATE inbox_mail SET next_try = now() WHERE email_id = $1`, [id(6)]);
  await post(api.base, event(id(6)), signed(event(id(6)))); // a new delivery ID kicks the worker
  const retried = forwards().filter((m) => m.subject === "[skovern.com] Retry me").length;
  check("N1", r6.status === 200 && firstTry === "pending" && (await outcome(id(6))) === "forwarded" && retried === 1, `first try ${firstTry}, then ${await outcome(id(6))}, sent ${retried}`);

  // F4: the budget (3) is spent: two more are held, one alert, one log line each.
  for (const n of [4, 5]) {
    h.inbound.set(id(n), received(id(n)));
    const r = await post(api.base, event(id(n)), signed(event(id(n))));
    check("F4", r.status === 200 && (await outcome(id(n))) === "held", `over budget → ${r.status}, ${await outcome(id(n))}`);
  }
  const alerts = forwards().filter((m) => m.subject === "[skovern.com] Forwarding paused for today");
  const sentOn = forwards().filter((m) => !m.subject.startsWith("[spam?] ")).length - alerts.length;
  check("F4", sentOn === 3 && alerts.length === 1 && alerts[0]?.to === FORWARD_TO, `forwards ${sentOn}, alerts ${alerts.length}`);
  check("F4", alerts[0]?.text.startsWith("Forwarding paused for today. New mail is waiting in Resend") === true && /^summary\/\d{4}-\d\d-\d\d$/.test(alerts[0]?.key ?? ""), `alert key ${alerts[0]?.key}`);
  const used = await pool.query<{ kind: string; n: string }>(`SELECT kind, count(*) AS n FROM resend_usage WHERE kind NOT IN ('welcome', 'signin') GROUP BY kind ORDER BY kind`);
  const tally = used.rows.map((r) => `${r.kind}=${r.n}`).join(",");
  check("F4", tally === "flagged=1,forward=3,received=7,summary=1", `shared quota counts ${tally}`);
  // P1 (bounce pause): every welcome sent earlier kept Resend's ID, and a signed
  // bounce for one is matched to it.
  const ids = await pool.query<{ total: string; named: string; one: string | null }>(
    `SELECT count(*) AS total, count(resend_id) AS named, min(resend_id) AS one FROM waitlist_welcome_sends`,
  );
  const w = ids.rows[0]!;
  const bounce = JSON.stringify({ type: "email.bounced", created_at: "2026-10-27T10:00:00.000Z", data: { email_id: w.one, tags: { kind: "welcome" } } });
  const br = await post(api.base, bounce, signed(bounce));
  const matched = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM mail_feedback f JOIN waitlist_welcome_sends s ON s.resend_id = f.email_id`,
  );
  check("P1", Number(w.total) > 0 && w.named === w.total && br.status === 200 && matched.rows[0]?.n === "1",
    `welcomes with Resend IDs ${w.named}/${w.total}, bounce → ${br.status}, matched ${matched.rows[0]?.n}`);

  // S2: with INBOX_FROM_FALLBACK=1 the api warns at startup that it sends from skovern.com.
  const fallback = await h.startApi({ RESEND_WEBHOOK_SECRET: `whsec_${KEY.toString("base64")}`, FORWARD_TO, INBOX_FROM_FALLBACK: "1" });
  let fbLogs = fallback.logs();
  for (let i = 0; i < 20 && !fbLogs.includes("WARNING"); i += 1) {
    await new Promise((w) => setTimeout(w, 250));
    fbLogs = fallback.logs();
  }
  check("055-S2", fbLogs.includes("WARNING: inbox forwards go out from inbox@skovern.com (INBOX_FROM_FALLBACK=1)"), "fallback warns at startup");
  check("055-S2", !api.logs().includes("INBOX_FROM_FALLBACK=1"), "no warning without the flag");

  const logs = api.logs();
  const spent = logs.split("\n").filter((l) => l.includes("forward budget spent")).length;
  check("F4", spent === 2, `${spent} budget-spent log lines`);
  check("F4", !/rosa@|dawid@|whsec_/.test(logs), "logs carry no addresses or secrets");
  return api;
}

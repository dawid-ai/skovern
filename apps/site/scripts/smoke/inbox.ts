// Loop 052 metric, image half: F1–F7 against the production image, with the
// fake Resend (over TLS) serving the Receiving API. Signs webhooks the way Svix
// does, independently of the code under test.
import { createHmac } from "node:crypto";
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
  JSON.stringify({ type: "email.received", created_at: new Date().toISOString(), data: { email_id: emailId, ...extra } });
const received = (emailId: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  object: "email", id: emailId, from: "Rosa <rosa@bloom.test>", to: ["hi@skovern.com"], cc: [], bcc: [], reply_to: [],
  subject: "Do you do weddings?", text: "June 14, about 80 people.", html: "<p>June 14, about 80 people.</p>",
  headers: {}, authentication: { spf: "pass", dkim: "pass", dmarc: "pass" }, attachments: [], ...over,
});

export async function inboxClauses(h: Harness, check: Check, baseWithoutSecret: string): Promise<Api> {
  const post = (base: string, body: string, headers: Record<string, string>): Promise<Response> =>
    fetch(`${base}${HOOK}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

  // F6: the image without RESEND_WEBHOOK_SECRET doesn't mount the route.
  const unmounted = await post(baseWithoutSecret, event(id(1)), signed(event(id(1))));
  check("F6", unmounted.status === 404, `no secret → ${unmounted.status}`);

  const api = await h.startApi({
    RESEND_WEBHOOK_SECRET: `whsec_${KEY.toString("base64")}`,
    FORWARD_TO,
    FORWARD_MAX_PER_DAY: "2",
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
  check("F1", fwd?.to === FORWARD_TO && fwd.from === "Skovern inbox <inbox@skovern.com>" && fwd.auth === "Bearer re_smoke_key", "to FORWARD_TO from the inbox address");
  check("F1", fwd?.reply_to === "rosa@bloom.test" && fwd.subject === "[skovern.com] Do you do weddings?", `Reply-To ${fwd?.reply_to}, subject "${fwd?.subject}"`);
  check("F1", fwd?.attachments?.[0]?.path === "https://inbound-cdn.test/a1" && fwd.text.includes("To: hi@skovern.com"), "attachment kept, original To at the top");

  // F3: the same delivery again is a 200 and no second forward.
  const replay = await post(api.base, body1, good);
  check("F3", replay.status === 200 && forwards().length === 1, `replay → ${replay.status}, sends ${forwards().length}`);

  // F5: mail from our own domain is never forwarded.
  h.inbound.set(id(2), received(id(2), { from: "Skovern <hi@skovern.com>" }));
  const own = await post(api.base, event(id(2)), signed(event(id(2))));
  check("F5", own.status === 200 && forwards().length === 1, `from @skovern.com → ${own.status}, sends ${forwards().length}`);

  // F7: the webhook body's sender, subject, and recipients are ignored.
  h.inbound.set(id(3), received(id(3), { subject: "From the API", authentication: { spf: "fail", dkim: "pass", dmarc: "pass" } }));
  const body3 = event(id(3), { from: "boss@bank.test", to: ["evil@attacker.test"], subject: "From the webhook", text: "pwned" });
  const f7 = await post(api.base, body3, signed(body3));
  const third = forwards()[1];
  check("F7", f7.status === 200 && h.fetched.includes(`/emails/receiving/${id(3)}?html_format=cid`), "fetched by ID from the Receiving API");
  check("F7", third?.to === FORWARD_TO && third.subject === "[spam?] [skovern.com] From the API" && !/attacker|pwned|bank\.test/.test(JSON.stringify(third)), `subject "${third?.subject}"`);

  // F4: the budget (2) is spent: two more are held, one summary, one log line each.
  for (const n of [4, 5]) {
    h.inbound.set(id(n), received(id(n)));
    const r = await post(api.base, event(id(n)), signed(event(id(n))));
    check("F4", r.status === 200, `over budget → ${r.status}`);
  }
  const summaries = forwards().filter((m) => m.subject.includes("waiting in Resend"));
  const held = forwards().length - summaries.length;
  check("F4", held === 2 && summaries.length === 1 && summaries[0]?.to === FORWARD_TO, `forwards ${held}, summaries ${summaries.length}`);
  check("F4", summaries[0]?.text.startsWith("1 email waiting in Resend.") === true, `summary "${summaries[0]?.subject}"`);
  const logs = api.logs();
  const spent = logs.split("\n").filter((l) => l.includes("forward budget spent")).length;
  check("F4", spent === 2, `${spent} budget-spent log lines`);
  check("F4", !/rosa@|dawid@|whsec_/.test(logs), "logs carry no addresses or secrets");
  return api;
}

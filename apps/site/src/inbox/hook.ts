import type { IncomingMessage } from "node:http";
import type pg from "pg";
import type { HttpResult } from "../auth/handlers.js";
import { readRawBuffer } from "../http.js";
import { recordFeedback, type FeedbackKind } from "../waitlist/bounce-pause.js";
import { EMAIL_ID } from "./resend-api.js";
import type { InboxStore } from "./store.js";
import { RefusalLog } from "./refusals.js";
import { verifySvix } from "./svix.js";
import type { InboxWorker } from "./worker.js";

// POST /hooks/resend/inbound: Resend's signed webhook. Mounted only when
// RESEND_WEBHOOK_SECRET is set. Handles:
// - email.received → record it as pending (counted against the quota) and
//   answer at once; the worker forwards it to FORWARD_TO (worker.ts)
// - email.bounced, email.complained, email.suppressed → the welcome bounce pause
// Every other event type is acknowledged and ignored. There's no per-address
// limit: Resend's senders share addresses with every other Resend account, so a
// limit on bad signatures would let anyone lock out real deliveries. Checking a
// signature is cheap and the body is capped.

export const HOOK_PATH = "/hooks/resend/inbound";

/** A received-email event lists every recipient and attachment; still small. */
const MAX_HOOK_BODY = 256 * 1024;

export interface InboxRouteContext {
  /** The signing key: the decoded base64 part of `whsec_...`. */
  key: Buffer;
  store: InboxStore;
  worker: InboxWorker;
  /** For the bounce and complaint records. */
  pool: pg.Pool;
  now?: () => number;
  /** Where refused signatures are counted (one log line a minute). */
  refusals?: RefusalLog;
}

const sharedRefusals = new RefusalLog();

const FEEDBACK: Record<string, FeedbackKind> = {
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.suppressed": "suppressed",
};

const OK: HttpResult = { status: 200, body: { ok: true } };
const UNSIGNED: HttpResult = { status: 401, body: { ok: false, message: "Bad signature." } };
const RETRY: HttpResult = { status: 500, body: { ok: false, message: "Try again later." } };

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** The `kind` tag of the email an event is about. Resend sends tags as an
 *  object; an array of `{name, value}` is read too. */
function kindTag(tags: unknown): string | null {
  if (Array.isArray(tags)) {
    const t = tags.find((x: unknown) => (x as { name?: unknown })?.name === "kind") as { value?: unknown } | undefined;
    return typeof t?.value === "string" ? t.value : null;
  }
  const v = tags && typeof tags === "object" ? (tags as Record<string, unknown>)["kind"] : null;
  return typeof v === "string" ? v : null;
}

async function handleEvent(ctx: InboxRouteContext, event: { type?: unknown; data?: unknown }): Promise<HttpResult> {
  const data = event.data && typeof event.data === "object" ? (event.data as Record<string, unknown>) : {};
  const emailId = typeof data["email_id"] === "string" ? data["email_id"] : "";
  if (event.type === "email.received") {
    if (!EMAIL_ID.test(emailId)) return { status: 400, body: { ok: false, message: "No email ID." } };
    // Only the ID is taken from the event. Who sent it, what it says, and where
    // it goes all come from the Receiving API and the config (forward.ts).
    await ctx.store.receive(emailId);
    // After this response is written, not before: Resend doesn't wait on the forward.
    setImmediate(() => ctx.worker.kick());
    return { status: 200, body: { ok: true, queued: true } };
  }
  const kind = typeof event.type === "string" ? FEEDBACK[event.type] : undefined;
  if (kind && emailId) await recordFeedback(ctx.pool, emailId, kind, kindTag(data["tags"]));
  return OK;
}

async function attempt(ctx: InboxRouteContext, req: IncomingMessage): Promise<HttpResult> {
  const id = header(req, "svix-id");
  let raw: Buffer;
  try {
    raw = await readRawBuffer(req, MAX_HOOK_BODY);
  } catch {
    // Real events are a few KB; this is worth a look, with the ID to find it in Resend.
    console.warn(`[inbox] webhook body over limit (${MAX_HOOK_BODY} bytes), svix-id ${(id ?? "none").slice(0, 64)}`);
    return { status: 413, body: { ok: false, message: "Too big." } };
  }
  const verdict = verifySvix(
    ctx.key,
    { id, timestamp: header(req, "svix-timestamp"), signature: header(req, "svix-signature") },
    raw,
    (ctx.now ?? Date.now)(),
  );
  if (verdict !== "ok" || !id) {
    (ctx.refusals ?? sharedRefusals).note(verdict);
    return UNSIGNED;
  }
  let event: { type?: unknown; data?: unknown };
  try {
    event = JSON.parse(raw.toString("utf8")) as { type?: unknown; data?: unknown };
  } catch {
    return { status: 400, body: { ok: false, message: "Bad request." } };
  }
  // A replayed (or retried, after a success) delivery is acknowledged and dropped.
  if (!(await ctx.store.firstSight(id))) return { status: 200, body: { ok: true, duplicate: true } };
  try {
    return await handleEvent(ctx, event);
  } catch (err) {
    console.error("[inbox] couldn't record the webhook; Resend will retry:", (err as Error).message);
    await ctx.store.forget(id).catch(() => {});
    return RETRY;
  }
}

export function handleInboxHook(ctx: InboxRouteContext, req: IncomingMessage): Promise<HttpResult> {
  if (req.method !== "POST") return Promise.resolve({ status: 405, body: { ok: false, message: "Use POST." } });
  return attempt(ctx, req);
}

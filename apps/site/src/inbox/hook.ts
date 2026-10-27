import type { IncomingMessage } from "node:http";
import type pg from "pg";
import type { HttpResult } from "../auth/handlers.js";
import { clientIp, readRawBody } from "../http.js";
import { LIMITS, limitFailures, type RateLimiter } from "../server/rate-limit.js";
import { recordFeedback, type FeedbackKind } from "../waitlist/bounce-pause.js";
import { forwardReceived, type ForwardDeps } from "./forward.js";
import { EMAIL_ID } from "./resend-api.js";
import { verifySvix } from "./svix.js";

// POST /hooks/resend/inbound: Resend's signed webhook. Mounted only when
// RESEND_WEBHOOK_SECRET is set. Handles:
// - email.received → forward it to FORWARD_TO (forward.ts)
// - email.bounced, email.complained → feed the welcome bounce pause
// Every other event type is acknowledged and ignored.

export const HOOK_PATH = "/hooks/resend/inbound";

/** A received-email event lists every recipient and attachment; still small. */
const MAX_HOOK_BODY = 256 * 1024;

export interface InboxRouteContext {
  /** The signing key: the decoded base64 part of `whsec_...`. */
  key: Buffer;
  forward: ForwardDeps;
  /** For the bounce and complaint records. */
  pool: pg.Pool;
  limiter: RateLimiter;
  trustProxy: boolean;
  now?: () => number;
}

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
    const outcome = await forwardReceived(ctx.forward, emailId);
    console.log(`[inbox] email ${emailId}: ${outcome}`);
    return { status: 200, body: { ok: true, outcome } };
  }
  if (event.type === "email.bounced" || event.type === "email.complained") {
    if (!emailId) return OK;
    const kind: FeedbackKind = event.type === "email.bounced" ? "bounced" : "complained";
    await recordFeedback(ctx.pool, emailId, kind, kindTag(data["tags"]));
    return OK;
  }
  return OK;
}

async function attempt(ctx: InboxRouteContext, req: IncomingMessage): Promise<HttpResult> {
  let raw: string;
  try {
    raw = await readRawBody(req, MAX_HOOK_BODY);
  } catch {
    return { status: 413, body: { ok: false, message: "Too big." } };
  }
  const id = header(req, "svix-id");
  const verdict = verifySvix(
    ctx.key,
    { id, timestamp: header(req, "svix-timestamp"), signature: header(req, "svix-signature") },
    raw,
    (ctx.now ?? Date.now)(),
  );
  if (verdict !== "ok" || !id) {
    console.warn(`[inbox] webhook refused: ${verdict}`);
    return UNSIGNED;
  }
  let event: { type?: unknown; data?: unknown };
  try {
    event = JSON.parse(raw) as { type?: unknown; data?: unknown };
  } catch {
    return { status: 400, body: { ok: false, message: "Bad request." } };
  }
  // A replayed (or retried, after a success) delivery is acknowledged and dropped.
  if (!(await ctx.forward.store.firstSight(id))) return { status: 200, body: { ok: true, duplicate: true } };
  try {
    return await handleEvent(ctx, event);
  } catch (err) {
    console.error("[inbox] webhook failed; Resend will retry:", (err as Error).message);
    await ctx.forward.store.forget(id).catch(() => {});
    return RETRY;
  }
}

/** Only failed signatures count against the per-address limit, so Resend's
 *  real deliveries are never throttled. */
export function handleInboxHook(ctx: InboxRouteContext, req: IncomingMessage): Promise<HttpResult> {
  if (req.method !== "POST") return Promise.resolve({ status: 405, body: { ok: false, message: "Use POST." } });
  const key = `hook-fail:${clientIp(req, ctx.trustProxy)}`;
  return limitFailures(ctx.limiter, key, LIMITS.hookFail, () => attempt(ctx, req), (r) => r.status === 401);
}

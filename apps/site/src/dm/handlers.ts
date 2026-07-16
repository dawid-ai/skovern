import type { HttpResult } from "../auth/handlers.js";
import { requireAdmin } from "../auth/admin.js";
import { escapeHtml } from "../html.js";
import type { AuthService } from "../auth/service.js";
import type { AdminDmMessage, DmStore } from "./store.js";
import type { Notifier } from "./notifier.js";

// Cap the stored/forwarded body so a single POST can't wedge the DB or the
// Telegram call. Messages to a founder are short.
const MAX_MESSAGE = 4000;

export interface DmDeps {
  auth: AuthService;
  store: DmStore;
  notifier: Notifier;
}

function readString(body: unknown, key: string): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/** POST /dm — an account holder writes to the founder. Session required. */
export async function handleDm(
  deps: DmDeps,
  sessionToken: string | null,
  body: unknown,
): Promise<HttpResult> {
  const account = sessionToken ? await deps.auth.validateSession(sessionToken) : null;
  if (!account) {
    return { status: 401, body: { ok: false, message: "Please sign in first." } };
  }
  const message = readString(body, "message")?.trim();
  if (!message) {
    return { status: 400, body: { ok: false, message: "Type a message first." } };
  }
  const clipped = message.slice(0, MAX_MESSAGE);

  // Save first — the user's message must survive even if the forward fails.
  await deps.store.insert(account.accountId, clipped, "user");
  try {
    await deps.notifier.notify({ email: account.email, body: clipped });
  } catch (err) {
    console.error("[dm] forward failed (message saved):", (err as Error).message);
  }
  return { status: 200, body: { ok: true, message: "Got it — Dawid will see this. Thanks!" } };
}

/** GET /dm/thread — the signed-in user's own conversation + unseen-reply count. */
export async function handleDmThread(deps: DmDeps, sessionToken: string | null): Promise<HttpResult> {
  const account = sessionToken ? await deps.auth.validateSession(sessionToken) : null;
  if (!account) return { status: 401, body: { ok: false, message: "Please sign in first." } };
  const thread = await deps.store.thread(account.accountId);
  return { status: 200, body: { ok: true, ...thread } };
}

/** POST /dm/read — mark the user's founder replies as seen. */
export async function handleDmRead(deps: DmDeps, sessionToken: string | null): Promise<HttpResult> {
  const account = sessionToken ? await deps.auth.validateSession(sessionToken) : null;
  if (!account) return { status: 401, body: { ok: false, message: "Please sign in first." } };
  await deps.store.markRead(account.accountId);
  return { status: 200, body: { ok: true } };
}

/** POST /admin/dm/reply — the founder replies to a specific user (form POST from
 *  the admin page, so the strict-CSP page needs no JS). Basic-auth guarded. */
export async function handleAdminDmReply(
  deps: DmDeps,
  adminToken: string | null,
  authHeader: string | null,
  form: URLSearchParams,
): Promise<HttpResult> {
  const denied = requireAdmin(adminToken, authHeader);
  if (denied) return denied;
  const accountId = form.get("accountId")?.trim();
  const body = form.get("body")?.trim();
  if (!accountId || !body) {
    return { status: 400, body: "accountId and body are required.", contentType: "text/plain" };
  }
  try {
    await deps.store.insert(accountId, body.slice(0, MAX_MESSAGE), "founder");
  } catch {
    return { status: 400, body: "Unknown account.", contentType: "text/plain" };
  }
  // Redirect back so the browser refreshes the thread (see the reply land).
  return { status: 303, body: "", headers: { location: "/admin/dm" } };
}

const ADMIN_HEADERS = {
  // Escaping is complete; form-action 'self' lets the reply forms POST back,
  // default-src 'none' blocks everything else.
  "content-security-policy": "default-src 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
};

/** GET /admin/dm — the founder's inbox: one section per user (their thread +
 *  a reply box). Basic-auth token guarded. */
export async function handleAdminDm(
  deps: DmDeps,
  adminToken: string | null,
  authHeader: string | null,
): Promise<HttpResult> {
  const denied = requireAdmin(adminToken, authHeader);
  if (denied) return denied;

  // Group newest-first list into per-account conversations (oldest-first inside).
  const byAccount = new Map<string, { email: string; messages: AdminDmMessage[] }>();
  for (const m of await deps.store.list()) {
    const group = byAccount.get(m.accountId) ?? { email: m.email, messages: [] };
    group.messages.unshift(m); // list() is newest-first → unshift = oldest-first
    byAccount.set(m.accountId, group);
  }

  const sections = [...byAccount.entries()]
    .map(([accountId, { email, messages }]) => {
      const turns = messages
        .map(
          (m) =>
            `<p><strong>${m.sender === "founder" ? "You" : escapeHtml(email)}:</strong> ` +
            `${escapeHtml(m.body)} <time>${escapeHtml(m.createdAt)}</time></p>`,
        )
        .join("\n");
      return (
        `<section><h2>${escapeHtml(email)}</h2>${turns}` +
        `<form method="post" action="/admin/dm/reply">` +
        `<input type="hidden" name="accountId" value="${escapeHtml(accountId)}">` +
        `<textarea name="body" rows="2" placeholder="Reply…"></textarea>` +
        `<button type="submit">Reply</button></form></section>`
      );
    })
    .join("\n");

  const html =
    `<!doctype html><meta charset="utf-8"><title>Skovern DMs</title>` +
    `<h1>Messages (${byAccount.size})</h1>${sections || "<p>No messages yet.</p>"}`;
  return { status: 200, body: html, contentType: "text/html", headers: ADMIN_HEADERS };
}

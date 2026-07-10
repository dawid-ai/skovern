import type { HttpResult } from "../auth/handlers.js";
import { requireAdmin } from "../auth/admin.js";
import { escapeHtml } from "../html.js";
import type { AuthService } from "../auth/service.js";
import type { DmStore } from "./store.js";
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
  await deps.store.insert(account.accountId, clipped);
  try {
    await deps.notifier.notify({ email: account.email, body: clipped });
  } catch (err) {
    console.error("[dm] forward failed (message saved):", (err as Error).message);
  }
  return { status: 200, body: { ok: true, message: "Got it — Dawid will see this. Thanks!" } };
}

/** GET /admin/dm — the founder reads the thread. Basic-auth token guarded.
 *  Read-only this loop; replying is out-of-band (the founder has the email). */
export async function handleAdminDm(
  deps: DmDeps,
  adminToken: string | null,
  authHeader: string | null,
): Promise<HttpResult> {
  const denied = requireAdmin(adminToken, authHeader);
  if (denied) return denied;

  const messages = await deps.store.list();
  const rows = messages
    .map(
      (m) =>
        `<article><header>${escapeHtml(m.email)} · <time>${escapeHtml(m.createdAt)}</time></header>` +
        `<p>${escapeHtml(m.body)}</p></article>`,
    )
    .join("\n");
  const html =
    `<!doctype html><meta charset="utf-8"><title>Deskhand DMs</title>` +
    `<h1>Messages (${messages.length})</h1>${rows || "<p>No messages yet.</p>"}`;
  return {
    status: 200,
    body: html,
    contentType: "text/html",
    // Defense-in-depth: this page shows user-submitted content. Escaping is
    // complete; the CSP means even a missed sink can't load or run anything.
    headers: { "content-security-policy": "default-src 'none'", "x-content-type-options": "nosniff" },
  };
}

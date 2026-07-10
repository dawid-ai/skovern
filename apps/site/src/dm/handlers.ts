import type { HttpResult } from "../auth/handlers.js";
import type { AuthService } from "../auth/service.js";
import { secretMatches, sha256 } from "../auth/tokens.js";
import type { DmStore } from "./store.js";
import type { Notifier } from "./notifier.js";

// Cap the stored/forwarded body so a single POST can't wedge the DB or the
// Telegram call. Messages to a founder are short.
const MAX_MESSAGE = 4000;

export interface DmDeps {
  auth: AuthService;
  store: DmStore;
  notifier: Notifier;
  /** From env; null disables the admin surface entirely. */
  adminToken: string | null;
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

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** Extract the password from an `Authorization: Basic base64(user:pass)` header. */
function basicPassword(header: string | null): string | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    return colon < 0 ? decoded : decoded.slice(colon + 1);
  } catch {
    return null;
  }
}

const UNAUTHORIZED: HttpResult = {
  status: 401,
  body: "Unauthorized",
  contentType: "text/plain",
  headers: { "www-authenticate": 'Basic realm="Deskhand admin"' },
};

/** GET /admin/dm — the founder reads the thread. Basic-auth token guarded.
 *  Read-only this loop; replying is out-of-band (the founder has the email). */
export async function handleAdminDm(deps: DmDeps, authHeader: string | null): Promise<HttpResult> {
  // No admin token configured → the surface simply doesn't exist.
  if (!deps.adminToken) return UNAUTHORIZED;
  const provided = basicPassword(authHeader);
  if (!provided || !secretMatches(provided, sha256(deps.adminToken))) return UNAUTHORIZED;

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
  return { status: 200, body: html, contentType: "text/html" };
}

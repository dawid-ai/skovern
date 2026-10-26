import { randomBytes } from "node:crypto";
import type { HttpResult } from "../auth/handlers.js";
import { escapeHtml } from "../html.js";
import type { WelcomeMailer } from "./mail.js";
import { deliverWelcome } from "./welcome.js";
import type { WaitlistStore } from "./store.js";
import { checkDetails, checkSignup, type FieldError } from "./validate.js";

export interface WaitlistDeps {
  store: WaitlistStore;
  mailer: WelcomeMailer;
  /** Public base of this API, for the remove link in the welcome email. */
  appUrl: () => string;
}

const invalid = (error: FieldError): HttpResult => ({
  status: 400,
  body: { ok: false, field: error.field, message: error.message },
});

/** POST /api/waitlist — step 1. New or repeat email: same 201 shape, same number. */
export async function handleJoin(deps: WaitlistDeps, body: unknown): Promise<HttpResult> {
  const checked = checkSignup(body);
  if (!checked.ok) return invalid(checked.error);
  const { name, email, bot } = checked.value;
  if (bot) {
    // The honeypot was filled. Look exactly like a success; store and send nothing.
    const number = await deps.store.plausibleNumber();
    return { status: 201, body: { number, detailsToken: randomBytes(32).toString("base64url") } };
  }
  const joined = await deps.store.join(email, name);
  const detailsToken = await deps.store.issueToken(joined.id, "details");
  // Over the global email budget, the claim is null and the welcome waits in
  // the backlog; the person still gets the normal answer and their number.
  if (joined.welcomeClaim) {
    await deliverWelcome(deps, { id: joined.id, email, name, number: joined.number, claim: joined.welcomeClaim });
  }
  return { status: 201, body: { number: joined.number, detailsToken } };
}

/** POST /api/waitlist/details — optional step 2. */
export async function handleDetails(deps: WaitlistDeps, body: unknown): Promise<HttpResult> {
  const checked = checkDetails(body);
  if (!checked.ok) return invalid(checked.error);
  const { token, ...details } = checked.value;
  const saved = await deps.store.saveDetails(token, details);
  if (!saved) {
    return invalid({
      field: "detailsToken",
      message: "This form timed out. Your spot is saved, so you can skip this.",
    });
  }
  return { status: 204, body: "" };
}

// --- Remove page (linked from the welcome email) ----------------------------

const PAGE_CSP = (nonce: string): string =>
  `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

function page(title: string, inner: string, status = 200): HttpResult {
  const nonce = randomBytes(16).toString("base64");
  const html =
    `<!doctype html><html lang="en"><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${escapeHtml(title)} · Skovern</title>` +
    `<style nonce="${nonce}">` +
    `:root{color-scheme:light dark;--bg:#f5f5f7;--card:#fff;--ink:#1d1d1f;--ink2:#6e6e73;--accent:#c85f17;--on:#fff}` +
    `@media (prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--ink:#f5f5f7;--ink2:#a1a1a6;--accent:#ff9a52;--on:#1d1206}}` +
    `body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);` +
    `font:400 17px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}` +
    `main{max-width:440px;width:100%;background:var(--card);border-radius:24px;padding:36px 28px;text-align:center}` +
    `h1{font-size:28px;line-height:1.15;letter-spacing:-.02em;margin:0 0 10px}p{margin:0 0 20px;color:var(--ink2)}` +
    `button{height:48px;padding:0 26px;border:0;border-radius:999px;background:var(--accent);color:var(--on);font:600 17px system-ui,sans-serif;cursor:pointer}` +
    `a{color:var(--accent)}</style><main>${inner}</main></html>`;
  return {
    status,
    body: html,
    contentType: "text/html; charset=utf-8",
    headers: {
      "content-security-policy": PAGE_CSP(nonce),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  };
}

const DEAD_LINK = (): HttpResult =>
  page(
    "Link expired",
    `<h1>This link doesn't work anymore.</h1>` +
      `<p>You may already be off the list. If you still get emails from us, write to ` +
      `<a href="mailto:hi@skovern.com">hi@skovern.com</a> and we'll sort it out.</p>`,
    404,
  );

/** GET /waitlist/remove?t=… — shows a confirm button only. Link scanners that
 *  prefetch email links can't remove anyone, because only the POST deletes. */
export async function handleRemovePage(deps: WaitlistDeps, token: string | null): Promise<HttpResult> {
  if (!token || !(await deps.store.canRemove(token))) return DEAD_LINK();
  return page(
    "Leave the waitlist",
    `<h1>Leave the Skovern waitlist?</h1>` +
      `<p>We'll delete your name, email, and answers. You can always join again later.</p>` +
      `<form method="post" action="/waitlist/remove"><input type="hidden" name="t" value="${escapeHtml(token)}">` +
      `<button type="submit">Remove me</button></form>`,
  );
}

/** POST /waitlist/remove — deletes. Also serves RFC 8058 one-click unsubscribe. */
export async function handleRemove(deps: WaitlistDeps, token: string | null): Promise<HttpResult> {
  if (!token || !(await deps.store.remove(token))) return DEAD_LINK();
  return page(
    "You're off the list",
    `<h1>You're off the list.</h1>` +
      `<p>We deleted your details. No more emails from us. Thanks for giving Skovern a look.</p>` +
      `<p><a href="https://skovern.com">Back to skovern.com</a></p>`,
  );
}

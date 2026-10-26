import { randomBytes } from "node:crypto";
import type { HttpResult } from "../auth/handlers.js";
import type { NewsStore } from "../news/store.js";
import type { AuthService } from "../auth/service.js";
import type { VisibilityStore } from "./visibility-store.js";
import { renderOgImage, renderPostPage, renderVisibilityPage } from "./render.js";
import { renderVisibilityCardPng } from "./og-card.js";
import { ogCards } from "./og-cache.js";

// Public, no-auth pages for published artifacts. First (only) content type is
// `news`; the shape /u/:type/:id generalizes to other artifacts later. `origin`
// is the absolute public base (configured APP_URL, else the request host) so
// og:image is absolute.

const NOT_FOUND: HttpResult = {
  status: 404,
  body: "<!doctype html><meta charset=utf-8><title>Not found</title><h1>Nothing here</h1>",
  contentType: "text/html",
};

// Public pages render admin-authored (news) AND user-published (visibility)
// content — all of it escape-first in render.ts. A strict CSP is cheap
// defense-in-depth (no scripts, images from same origin only), and it matters
// more now that some content originates from users + model output.
const PAGE_HEADERS = {
  "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
  "x-content-type-options": "nosniff",
};

/**
 * Route `/u/...` paths. `parts` is the path split on "/" with the leading ""
 * and "u" already consumed, e.g. ["news", "the-slug"] or
 * ["news", "the-slug", "og.svg"]. Returns 404 for anything unrecognized.
 */
export async function handlePublish(
  news: NewsStore,
  parts: string[],
  origin: string,
): Promise<HttpResult> {
  const [type, id, sub] = parts;
  if (type !== "news" || !id) return NOT_FOUND;

  let slug: string;
  try {
    slug = decodeURIComponent(id);
  } catch {
    // A malformed %-escape is just a bad URL → 404, not a 500.
    return NOT_FOUND;
  }
  const post = await news.getBySlug(slug);
  if (!post) return NOT_FOUND;

  if (sub === "og.svg") {
    return {
      status: 200,
      body: renderOgImage(post),
      contentType: "image/svg+xml",
      // nosniff + a locked CSP: even if the SVG is opened as a document, nothing
      // can execute. Defense-in-depth for when the renderer gains richer tags.
      headers: { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'" },
    };
  }
  if (sub === undefined) {
    return {
      status: 200,
      body: renderPostPage(post, origin),
      contentType: "text/html",
      headers: PAGE_HEADERS,
    };
  }
  return NOT_FOUND;
}

// --- Published AI Visibility results (loop 013b) ---------------------------

export interface PublishDeps {
  auth: AuthService;
  store: VisibilityStore;
}

function field(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined;
}

/** POST /publish/visibility — a signed-in user publishes their result. Session
 *  required (an OUTBOUND action → an authenticated owner). Returns the public URL. */
export async function handlePublishVisibility(
  deps: PublishDeps,
  sessionToken: string | null,
  body: unknown,
  origin: string,
): Promise<HttpResult> {
  const account = sessionToken ? await deps.auth.validateSession(sessionToken) : null;
  if (!account) return { status: 401, body: { ok: false, message: "Please sign in first." } };

  const business = typeof field(body, "business") === "string" ? (field(body, "business") as string).trim() : "";
  if (!business) return { status: 400, body: { ok: false, message: "Add your business name first." } };
  const score = field(body, "score");
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return { status: 400, body: { ok: false, message: "That result looks off — run the check again." } };
  }
  const rawComp = field(body, "competitors");
  const competitors = Array.isArray(rawComp) ? rawComp.filter((c): c is string => typeof c === "string") : [];

  const id = await deps.store.create({ accountId: account.accountId, business, score, competitors });
  return { status: 200, body: { ok: true, id, url: `${origin}/u/visibility/${id}` } };
}

/** GET /u/visibility/:id[/og.png] — the public page + its rasterised share card. */
export async function handleVisibilityPage(
  store: VisibilityStore,
  parts: string[],
  origin: string,
): Promise<HttpResult> {
  const [, id, sub] = parts;
  if (!id) return NOT_FOUND;
  let key: string;
  try {
    key = decodeURIComponent(id);
  } catch {
    return NOT_FOUND;
  }
  const v = await store.getById(key);
  if (!v) return NOT_FOUND;

  if (sub === "og.png") {
    const cached = ogCards.get(v.id);
    const png = cached ?? (await renderVisibilityCardPng(v));
    if (!cached) ogCards.set(v.id, png);
    return {
      status: 200,
      body: png,
      contentType: "image/png",
      headers: {
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'",
        // Immutable per id, so browsers and the edge can keep it a day.
        "cache-control": "public, max-age=86400",
        "x-skovern-cache": cached ? "hit" : "miss",
      },
    };
  }
  if (sub === undefined) {
    // The redesigned page carries one inline <style>. Keep the CSP strict — no
    // 'unsafe-inline' — by minting a fresh per-response nonce and gating styles on
    // it. Scripts stay blocked (default-src 'none'); nothing else is loosened.
    const nonce = randomBytes(16).toString("base64");
    const headers = {
      "content-security-policy": `default-src 'none'; img-src 'self'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`,
      "x-content-type-options": "nosniff",
    };
    return { status: 200, body: renderVisibilityPage(v, origin, nonce), contentType: "text/html", headers };
  }
  return NOT_FOUND;
}

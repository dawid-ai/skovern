import type { HttpResult } from "../auth/handlers.js";
import type { NewsStore } from "../news/store.js";
import { renderOgImage, renderPostPage } from "./render.js";

// Public, no-auth pages for published artifacts. First (only) content type is
// `news`; the shape /u/:type/:id generalizes to other artifacts later. `origin`
// is the absolute public base (configured APP_URL, else the request host) so
// og:image is absolute.

const NOT_FOUND: HttpResult = {
  status: 404,
  body: "<!doctype html><meta charset=utf-8><title>Not found</title><h1>Nothing here</h1>",
  contentType: "text/html",
};

// Public pages render admin-authored content that's already escaped; a strict
// CSP is cheap defense-in-depth (no scripts, images from same origin only).
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

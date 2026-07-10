import type { HttpResult } from "../auth/handlers.js";
import { requireAdmin } from "../auth/admin.js";
import type { NewsStore } from "./store.js";

// Framework-agnostic, same shape as the auth handlers: the server hands us the
// store, we return {status, body}. The feed is public — no session, by design
// (§10: readable without account).
export async function handleNews(store: NewsStore): Promise<HttpResult> {
  const posts = await store.listNews();
  return { status: 200, body: { ok: true, posts } };
}

function readString(body: unknown, key: string): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/** POST /admin/news — the founder publishes a post. Same Basic-auth guard as
 *  the DM admin thread. Upserts on slug, so it also edits an existing post. */
export async function handleAdminNews(
  store: NewsStore,
  adminToken: string | null,
  authHeader: string | null,
  body: unknown,
): Promise<HttpResult> {
  const denied = requireAdmin(adminToken, authHeader);
  if (denied) return denied;

  const slug = readString(body, "slug")?.trim();
  const title = readString(body, "title")?.trim();
  const postBody = readString(body, "body")?.trim();
  if (!slug || !title || !postBody) {
    return { status: 400, body: { ok: false, message: "slug, title and body are required." } };
  }
  const publishedAt = readString(body, "publishedAt") ?? undefined;
  // Validate before it hits `$4::timestamptz` — a bad date should 400, not
  // throw a generic 500 from Postgres.
  if (publishedAt !== undefined && Number.isNaN(Date.parse(publishedAt))) {
    return { status: 400, body: { ok: false, message: "publishedAt must be a date." } };
  }
  await store.publish({ slug, title, body: postBody, publishedAt });
  return { status: 200, body: { ok: true, slug } };
}

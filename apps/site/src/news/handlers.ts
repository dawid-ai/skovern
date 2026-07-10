import type { HttpResult } from "../auth/handlers.js";
import type { NewsStore } from "./store.js";

// Framework-agnostic, same shape as the auth handlers: the server hands us the
// store, we return {status, body}. The feed is public — no session, by design
// (§10: readable without account).
export async function handleNews(store: NewsStore): Promise<HttpResult> {
  const posts = await store.listNews();
  return { status: 200, body: { ok: true, posts } };
}

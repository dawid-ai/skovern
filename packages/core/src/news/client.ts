// UI → core → here. The renderer never fetches /news itself. No Electron
// imports, so this stays unit-testable and process-portable.

export interface NewsPost {
  slug: string;
  title: string;
  body: string;
  publishedAt: string;
}

export interface NewsClient {
  list(): Promise<NewsPost[]>;
}

function isPost(x: unknown): x is NewsPost {
  const p = x as Record<string, unknown>;
  return (
    typeof p?.["slug"] === "string" &&
    typeof p?.["title"] === "string" &&
    typeof p?.["body"] === "string" &&
    typeof p?.["publishedAt"] === "string"
  );
}

// `fetchImpl` defaults to global `fetch`; the desktop main process injects a
// receipted wrapper so every first-party call lands in the egress log. Not
// injecting keeps behavior (and these tests) unchanged.
export function createNewsClient(apiBase: string, fetchImpl: typeof fetch = fetch): NewsClient {
  return {
    async list(): Promise<NewsPost[]> {
      const res = await fetchImpl(`${apiBase}/news`);
      if (!res.ok) return [];
      const body = (await res.json().catch(() => null)) as { posts?: unknown } | null;
      const posts = body?.posts;
      // Trust the boundary, not the payload: keep only well-formed posts.
      return Array.isArray(posts) ? posts.filter(isPost) : [];
    },
  };
}

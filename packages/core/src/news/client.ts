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

export function createNewsClient(apiBase: string): NewsClient {
  return {
    async list(): Promise<NewsPost[]> {
      const res = await fetch(`${apiBase}/news`);
      if (!res.ok) return [];
      const body = (await res.json().catch(() => null)) as { posts?: unknown } | null;
      const posts = body?.posts;
      // Trust the boundary, not the payload: keep only well-formed posts.
      return Array.isArray(posts) ? posts.filter(isPost) : [];
    },
  };
}

import type pg from "pg";
import type { NewsPost } from "./posts.js";

type Pool = pg.Pool;

// Own migration, idempotent, kept separate from AuthStore so auth and news
// schemas don't tangle. main.ts runs both migrate() calls on boot.
const MIGRATION = `
CREATE TABLE IF NOT EXISTS news_posts (
  slug          text PRIMARY KEY,
  title         text NOT NULL,
  body          text NOT NULL,
  published_at  timestamptz NOT NULL
);
`;

type PostRow = { slug: string; title: string; body: string; published_at: Date };

export class NewsStore {
  constructor(private readonly pool: Pool) {}

  async migrate(): Promise<void> {
    await this.pool.query(MIGRATION);
  }

  /** Upsert the git-authored seed into the table. Idempotent on slug, so a
   *  reboot after editing posts.ts republishes the new copy. */
  async syncPosts(posts: NewsPost[]): Promise<void> {
    for (const p of posts) {
      await this.pool.query(
        `INSERT INTO news_posts (slug, title, body, published_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (slug) DO UPDATE
           SET title = EXCLUDED.title,
               body = EXCLUDED.body,
               published_at = EXCLUDED.published_at`,
        [p.slug, p.title, p.body, p.publishedAt],
      );
    }
  }

  /** Publish (or update) a single post from the admin surface. Same upsert as
   *  the boot seed; publishedAt defaults to now() when the caller omits it. */
  async publish(post: {
    slug: string;
    title: string;
    body: string;
    publishedAt?: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO news_posts (slug, title, body, published_at)
       VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()))
       ON CONFLICT (slug) DO UPDATE
         SET title = EXCLUDED.title,
             body = EXCLUDED.body,
             published_at = EXCLUDED.published_at`,
      [post.slug, post.title, post.body, post.publishedAt ?? null],
    );
  }

  /** Published posts, newest first. Selects only public columns — never *. */
  async listNews(): Promise<NewsPost[]> {
    const { rows } = await this.pool.query<PostRow>(
      `SELECT slug, title, body, published_at
         FROM news_posts
        ORDER BY published_at DESC`,
    );
    return rows.map((r) => ({
      slug: r.slug,
      title: r.title,
      body: r.body,
      publishedAt: r.published_at.toISOString(),
    }));
  }
}

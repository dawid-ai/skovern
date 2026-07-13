import { useEffect, useState } from "react";
import type { NewsPostView } from "../../../shared/cloud.js";

// "What's new" — the news feed on its own page. Owns its own fetch so the page
// is self-contained and reloads fresh each time it mounts.
export function NewsPage() {
  const [news, setNews] = useState<NewsPostView[] | null>(null);

  useEffect(() => {
    void window.deskhand.news.list().then(setNews);
  }, []);

  return (
    <section className="page">
      <header className="page-head">
        <h1>What&apos;s new</h1>
        <p>Ship notes and news from the people building Deskhand.</p>
      </header>

      {news === null ? (
        <p className="hint">Loading the latest…</p>
      ) : news.length === 0 ? (
        <p className="hint">Nothing here yet — check back soon.</p>
      ) : (
        <ul className="card-grid">
          {news.map((post) => (
            <li key={post.slug} className="content-card">
              <h3>{post.title}</h3>
              <p>{post.body}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

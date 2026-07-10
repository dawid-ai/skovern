import { escapeHtml } from "../html.js";
import type { NewsPost } from "../news/posts.js";

// The whole safety argument lives here: we ESCAPE first, then emit a fixed,
// tiny set of structural tags (<p>, <br>) that we generate ourselves. Nothing
// from the source can ever become live HTML — a body containing "<script>" is
// escaped to "&lt;script&gt;" before any tag is added. That's the sanitizer;
// no markdown/HTML-sanitizer dependency needed.
//
// ponytail: paragraphs + line breaks only — all the seeded posts use. Add
// bold/links/lists (still escape-first) when a post actually needs them.
export function renderMarkdown(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

/** A published post's public page: real HTML + OpenGraph tags for share cards.
 *  `origin` is the absolute base (e.g. https://deskhand.app) so og:image is
 *  absolute, which scrapers require. */
export function renderPostPage(post: NewsPost, origin: string): string {
  const title = escapeHtml(post.title);
  const ogImage = `${origin}/u/news/${encodeURIComponent(post.slug)}/og.svg`;
  return (
    `<!doctype html><html lang="en"><head>` +
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${title} · Deskhand</title>` +
    `<meta property="og:type" content="article">` +
    `<meta property="og:title" content="${title}">` +
    `<meta property="og:image" content="${escapeHtml(ogImage)}">` +
    `<meta name="twitter:card" content="summary_large_image">` +
    `</head><body>` +
    `<main><h1>${title}</h1><article>${renderMarkdown(post.body)}</article></main>` +
    `</body></html>`
  );
}

// OG card as an SVG string — no rasterizer, no dependency, self-contained.
// ponytail: SVG cards render in-app fine but some social scrapers only accept
// PNG/JPG. Swap this for satori+resvg (title → PNG) when scraper-perfect cards
// actually matter; the endpoint URL stays the same.
export function renderOgImage(post: NewsPost): string {
  const title = escapeHtml(clip(post.title, 80));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">` +
    `<rect width="1200" height="630" fill="#0f172a"/>` +
    `<text x="80" y="120" font-family="sans-serif" font-size="32" fill="#38bdf8">Deskhand</text>` +
    `<text x="80" y="330" font-family="sans-serif" font-size="64" font-weight="bold" fill="#f8fafc">${title}</text>` +
    `</svg>`
  );
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

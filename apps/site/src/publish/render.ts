import { escapeHtml } from "../html.js";
import type { NewsPost } from "../news/posts.js";
import type { PublishedVisibility } from "./visibility-store.js";

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
 *  `origin` is the absolute base (e.g. https://skovern.org) so og:image is
 *  absolute, which scrapers require. */
export function renderPostPage(post: NewsPost, origin: string): string {
  const title = escapeHtml(post.title);
  const ogImage = `${origin}/u/news/${encodeURIComponent(post.slug)}/og.svg`;
  return (
    `<!doctype html><html lang="en"><head>` +
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${title} · Skovern</title>` +
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
    `<text x="80" y="120" font-family="sans-serif" font-size="32" fill="#38bdf8">Skovern</text>` +
    `<text x="80" y="330" font-family="sans-serif" font-size="64" font-weight="bold" fill="#f8fafc">${title}</text>` +
    `</svg>`
  );
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// --- Published AI Visibility results (loop 013b) ---------------------------
// Same safety argument as the post page: escape EVERY user/model-supplied string
// (business name, competitor names) before it touches HTML. Numbers are clamped
// to 0–100 in the store, so the score is safe to interpolate.

function grade(score: number): string {
  if (score >= 67) return "AI knows them well";
  if (score >= 34) return "AI sort of knows them";
  return "AI barely knows them yet";
}

// The ring colour tracks the grade: warm green when AI knows them, brand orange
// in the middle, deep terracotta when AI barely knows them. Brand-consistent, and
// gives the score an at-a-glance read for someone who never opened the app.
function ringColor(score: number): string {
  if (score >= 67) return "#2f9e6f";
  if (score >= 34) return "#e87a2e";
  return "#c2532b";
}

/**
 * The public share page for a published AI Visibility result. A self-contained,
 * branded HTML document — no external CSS/JS/fonts (the strict CSP forbids them),
 * so the styling is one inline <style> that carries the per-response `nonce`, and
 * the score visual is an inline SVG ring (no script needed).
 *
 * SECURITY: escape-first, unchanged from 013b. Every business/competitor string
 * is run through escapeHtml before it touches markup; the score is a clamped
 * integer from the store. There is no dangerouslySetInnerHTML equivalent here and
 * no verbatim AI answers — summary only.
 */
export function renderVisibilityPage(v: PublishedVisibility, origin: string, nonce: string): string {
  const business = escapeHtml(v.business);
  const label = escapeHtml(grade(v.score));
  const ogImage = `${origin}/u/visibility/${encodeURIComponent(v.id)}/og.png`;
  const home = escapeHtml(origin);

  // Score ring geometry, computed server-side (no client JS). r=94 → circumference
  // ~590.6; the arc's dash length is score% of that, drawn from 12 o'clock.
  const R = 94;
  const C = 2 * Math.PI * R;
  const pct = Math.max(0, Math.min(100, v.score)) / 100;
  const arc = (pct * C).toFixed(1);
  const rest = (C - pct * C).toFixed(1);
  const ring = ringColor(v.score);

  const chips = v.competitors.length
    ? `<section class="also"><h2>Others AI brought up</h2><ul class="chips">` +
      v.competitors.map((c) => `<li>${escapeHtml(c)}</li>`).join("") +
      `</ul></section>`
    : "";

  const style =
    `*{margin:0;padding:0;box-sizing:border-box}` +
    `:root{--paper:#faf6f1;--panel:#fffdfb;--ink:#2b2620;--muted:#8a8178;--accent:#e87a2e;--line:#ece2d4;--ring:${ring}}` +
    `html,body{min-height:100%}` +
    `body{font-family:-apple-system,"Segoe UI",system-ui,sans-serif;color:var(--ink);` +
    `background:radial-gradient(120% 90% at 50% -10%,#fff6ea 0%,var(--paper) 55%);` +
    `display:flex;flex-direction:column;align-items:center;padding:40px 20px 56px;line-height:1.5}` +
    `.serif{font-family:Georgia,"Iowan Old Style","Palatino Linotype",Palatino,"Times New Roman",serif}` +
    `.card{width:100%;max-width:600px;background:var(--panel);border:1px solid var(--line);` +
    `border-radius:24px;padding:40px 36px;box-shadow:0 24px 60px -30px rgba(70,50,25,.35)}` +
    `.brand{display:flex;align-items:center;gap:8px;font-size:13px;letter-spacing:.14em;` +
    `text-transform:uppercase;color:var(--accent);font-weight:700}` +
    `.brand .petal{font-size:16px;line-height:1}` +
    `h1{font-size:34px;line-height:1.15;margin:18px 0 6px;font-weight:700}` +
    `.lede{color:var(--muted);font-size:15px}` +
    `.score{display:flex;flex-direction:column;align-items:center;margin:30px 0 8px}` +
    `.ring{position:relative;width:220px;height:220px}` +
    `.ring svg{width:220px;height:220px;transform:rotate(-90deg)}` +
    `.ring-num{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}` +
    `.ring-num b{font-size:58px;font-weight:700;line-height:1}` +
    `.ring-num i{font-style:normal;color:var(--muted);font-size:16px;margin-top:2px}` +
    `.grade{margin-top:16px;font-size:20px;font-weight:700}` +
    `.hint{color:var(--muted);font-size:14px;text-align:center;margin-top:4px}` +
    `.also{margin-top:30px;border-top:1px solid var(--line);padding-top:22px}` +
    `.also h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:12px}` +
    `.chips{list-style:none;display:flex;flex-wrap:wrap;gap:8px}` +
    `.chips li{background:#f4ece0;border:1px solid var(--line);border-radius:999px;padding:7px 14px;font-size:14px}` +
    `.cta{margin-top:30px;border-top:1px solid var(--line);padding-top:26px;text-align:center}` +
    `.cta p{color:var(--muted);font-size:15px;margin-bottom:14px}` +
    `.cta a{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;font-weight:700;` +
    `font-size:15px;padding:13px 22px;border-radius:14px}` +
    `.foot{margin-top:26px;color:var(--muted);font-size:12px;text-align:center}` +
    `@media(max-width:520px){.card{padding:30px 22px}h1{font-size:27px}.ring,.ring svg{width:180px;height:180px}.ring-num b{font-size:48px}}`;

  return (
    `<!doctype html><html lang="en"><head>` +
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${business} · AI Visibility · Skovern</title>` +
    `<meta name="description" content="How well AI knows ${business}: ${v.score} out of 100.">` +
    `<meta property="og:type" content="website">` +
    `<meta property="og:title" content="${business} — AI Visibility ${v.score}/100">` +
    `<meta property="og:description" content="${label}. See what AI says about your business — with Skovern.">` +
    `<meta property="og:image" content="${escapeHtml(ogImage)}">` +
    `<meta name="twitter:card" content="summary_large_image">` +
    `<style nonce="${nonce}">${style}</style>` +
    `</head><body>` +
    `<main class="card">` +
    `<div class="brand"><span class="petal">&#10047;</span> Skovern &middot; AI Visibility</div>` +
    `<h1 class="serif">${business}</h1>` +
    `<p class="lede">Here&rsquo;s how well AI knows this business right now.</p>` +
    `<div class="score">` +
    `<div class="ring">` +
    `<svg viewBox="0 0 220 220" role="img" aria-label="${v.score} out of 100">` +
    `<circle cx="110" cy="110" r="${R}" fill="none" stroke="#efe6d8" stroke-width="16"/>` +
    `<circle cx="110" cy="110" r="${R}" fill="none" stroke="var(--ring)" stroke-width="16" stroke-linecap="round" stroke-dasharray="${arc} ${rest}"/>` +
    `</svg>` +
    `<div class="ring-num"><b class="serif">${v.score}</b><i>out of 100</i></div>` +
    `</div>` +
    `<p class="grade serif">${label}</p>` +
    `<p class="hint">This is how often AI brought them up on its own &mdash; without being handed the name.</p>` +
    `</div>` +
    chips +
    `<div class="cta"><p>Curious how AI talks about <em>your</em> shop?</p>` +
    `<a href="${home}">See what AI says about your business</a></div>` +
    `<p class="foot">Made with Skovern &mdash; the friendly assistant for small businesses.</p>` +
    `</main></body></html>`
  );
}

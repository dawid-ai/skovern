import type { APIRoute } from "astro";
import { getPosts } from "../lib/posts";
import { SITE_URL } from "../lib/site";
import { xml } from "../lib/xml";

// Public, indexable pages only (the waitlist done/remove pages are noindex).
export const GET: APIRoute = async () => {
  const posts = await getPosts();
  const day = (d: Date): string => d.toISOString().slice(0, 10);
  const newest = posts[0]?.data.date;
  const urls: { loc: string; lastmod?: string }[] = [
    { loc: `${SITE_URL}/`, lastmod: newest && day(newest) },
    { loc: `${SITE_URL}/blog/`, lastmod: newest && day(newest) },
    { loc: `${SITE_URL}/privacy/` },
    ...posts.map((p) => ({ loc: `${SITE_URL}/blog/${p.id}/`, lastmod: day(p.data.updated ?? p.data.date) })),
  ];
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${xml(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`).join("\n")}
</urlset>
`;
  return new Response(body, { headers: { "content-type": "application/xml; charset=utf-8" } });
};

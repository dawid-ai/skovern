import type { APIRoute } from "astro";
import { author, getPosts } from "../lib/posts";
import { SITE_URL } from "../lib/site";
import { xml } from "../lib/xml";

export const GET: APIRoute = async () => {
  const posts = await getPosts();
  const items = posts
    .map((p) => {
      const url = `${SITE_URL}/blog/${p.id}/`;
      return `    <item>
      <title>${xml(p.data.title)}</title>
      <link>${url}</link>
      <guid isPermaLink="true">${url}</guid>
      <description>${xml(p.data.description)}</description>
      <pubDate>${p.data.date.toUTCString()}</pubDate>
      <dc:creator>${xml(author(p.data.author).name)}</dc:creator>
    </item>`;
    })
    .join("\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Skovern Blog</title>
    <link>${SITE_URL}/blog/</link>
    <atom:link href="${SITE_URL}/rss.xml" rel="self" type="application/rss+xml"/>
    <description>Plain-English guides on AI, privacy, and getting through the busywork. Written for shop owners, not tech people.</description>
    <language>en-us</language>
${items}
  </channel>
</rss>
`;
  return new Response(body, { headers: { "content-type": "application/rss+xml; charset=utf-8" } });
};

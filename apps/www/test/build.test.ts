import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// W1 + W3: assertions on the built site in dist/ (the `test` script builds first).

const root = join(import.meta.dirname, "..");
const dist = join(root, "dist");
const read = (p: string): string => readFileSync(join(dist, p), "utf8");
const css = (): string =>
  readdirSync(join(dist, "_astro"))
    .filter((f) => f.endsWith(".css"))
    .map((f) => readFileSync(join(dist, "_astro", f), "utf8"))
    .join("\n");

describe("W1: the home page waitlist form", () => {
  const html = read("index.html");

  it("has the form with a label for every field", () => {
    const form = html.match(/<form class="wl-s1"[\s\S]*?<\/form>/)?.[0] ?? "";
    expect(form).toMatch(/method="post"/);
    expect(form).toMatch(/action="https:\/\/api\.skovern\.com\/api\/waitlist"/);
    for (const [field, label] of [["name", "Your name"], ["email", "Email"]] as const) {
      const id = form.match(new RegExp(`<input id="([^"]+)" name="${field}"`))?.[1];
      expect(id, `input ${field}`).toBeTruthy();
      expect(form).toContain(`<label for="${id}">${label}</label>`);
    }
    expect(form).toContain('<button class="wl-go full" type="submit">Join the waitlist</button>');
  });

  it("hides the honeypot from people and from screen readers", () => {
    const hp = html.match(/<div class="wl-hp" aria-hidden="true">[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(hp).toMatch(/name="company_website"/);
    expect(hp).toMatch(/tabindex="-1"/);
    expect(hp).toMatch(/autocomplete="off"/);
    const rule = css().replace(/\s+/g, "").match(/\.wl-hp\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("position:absolute");
    expect(rule).toContain("left:-10000px");
    expect(rule).toContain("overflow:hidden");
  });

  it("offers no download link", () => {
    expect(html).not.toMatch(/\sdownload(=|\s|>)/i);
    expect(html).not.toMatch(/href="[^"]*(\.exe|\.msi|\.dmg|\/releases)[^"]*"/i);
    expect(html).not.toMatch(/\bDownload (Skovern|for|now|the app)/i);
  });

  it("uses the decided headline", () => {
    expect(html).toContain("Free AI for your shop. <span class=\"dim\">You control what leaves.</span>");
  });

  it("loads no script or style from another origin", () => {
    expect(html).not.toMatch(/<script[^>]+src="https?:/);
    expect(html).not.toMatch(/<link[^>]+href="https?:\/\/(?!skovern\.com)[^"]+"[^>]*stylesheet/);
    expect(html).not.toMatch(/<script(?![^>]*(type="module" src=|type="application\/ld\+json"))[^>]*>/);
  });
});

describe("W3: blog posts", () => {
  const files = readdirSync(join(root, "src/content/blog")).filter((f) => f.endsWith(".md"));
  const slugs = files.map((f) => f.replace(/\.md$/, ""));

  it("has at least one post", () => expect(slugs.length).toBeGreaterThan(0));

  it.each(slugs)("%s has a valid slug, title, description, and date", (slug) => {
    expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    const page = read(`blog/${slug}/index.html`);
    expect(page).toMatch(/<title>[^<]{8,} · Skovern Blog<\/title>/);
    expect(page).toMatch(/<meta name="description" content="[^"]{20,}">/);
    const ld = JSON.parse(page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? "{}") as Record<string, unknown>;
    expect(ld["@type"]).toBe("BlogPosting");
    expect(ld["datePublished"]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ld["author"]).toMatchObject({ name: "Dawid" });
  });

  it("lists every post in sitemap.xml and rss.xml", () => {
    const sitemap = read("sitemap.xml");
    const rss = read("rss.xml");
    for (const slug of slugs) {
      expect(sitemap).toContain(`<loc>https://skovern.com/blog/${slug}/</loc>`);
      expect(rss).toContain(`<link>https://skovern.com/blog/${slug}/</link>`);
    }
    expect(rss.match(/<item>/g)?.length).toBe(slugs.length);
  });

  it("fails the build when a post is missing front matter", () => {
    const tmp = join(root, ".w3-tmp");
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp);
    for (const p of ["src", "astro.config.mjs", "tsconfig.json"]) cpSync(join(root, p), join(tmp, p), { recursive: true });
    writeFileSync(join(tmp, "src/content/blog/no-front-matter.md"), "Just a body, no title or date.\n");
    const astro = join(root, "node_modules/astro/bin/astro.mjs");
    expect(existsSync(astro)).toBe(true);
    const r = spawnSync(process.execPath, [astro, "build", "--root", tmp], { encoding: "utf8", timeout: 170_000 });
    rmSync(tmp, { recursive: true, force: true });
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status).not.toBe(0);
    expect(out).toMatch(/no-front-matter/);
    expect(out).toMatch(/title/);
  });
});

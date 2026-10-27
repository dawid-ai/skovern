import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// The built site stays inline-free, so Caddy's Content-Security-Policy
// (script-src 'self'; style-src 'self') never blocks anything in production
// that `astro preview` would have run (ledger www-csp-inline-check, loop 053).
// Runs over every page in dist/ (the `test` script builds first).

const dist = join(import.meta.dirname, "..", "dist");

function pages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return pages(p);
    return e.name.endsWith(".html") ? [p] : [];
  });
}

describe("CSP: the built pages are inline-free", () => {
  const all = pages(dist);

  it("finds the pages", () => {
    expect(all.length).toBeGreaterThan(3);
    expect(all.map((p) => relative(dist, p).replaceAll("\\", "/"))).toContain("index.html");
  });

  for (const file of all) {
    const name = relative(dist, file).replaceAll("\\", "/");
    it(`${name}: scripts are files under /_astro/, JSON-LD aside; no <style>, no handlers`, () => {
      const html = readFileSync(file, "utf8");
      for (const tag of html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? []) {
        const open = tag.slice(0, tag.indexOf(">") + 1);
        const body = tag.slice(open.length, tag.length - "</script>".length);
        if (/type="application\/ld\+json"/i.test(open)) continue;
        expect(open, `${name}: script src`).toMatch(/\ssrc="\/_astro\/[^"]+\.js"/);
        expect(body.trim(), `${name}: inline script body`).toBe("");
      }
      expect(html, `${name}: <style> element`).not.toMatch(/<style\b/i);
      expect(html, `${name}: inline event handler`).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
      expect(html, `${name}: javascript: URL`).not.toMatch(/(href|src|action)\s*=\s*"\s*javascript:/i);
    });
  }
});

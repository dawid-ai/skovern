import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// H1 (the S is a real typeface glyph, the right way up) and H4 (weight).

const root = join(import.meta.dirname, "..");

describe("H1: the S", () => {
  it("is built from a font outline in the render script, not a hand-drawn curve", () => {
    const py = readFileSync(join(root, "art", "icon.py"), "utf8");
    expect(py).toMatch(/bpy\.data\.fonts\.load\(/);
    expect(py).toMatch(/bpy\.data\.curves\.new\("S", "FONT"\)/);
    expect(py).toMatch(/cu\.body = "S"/);
    expect(py).not.toMatch(/def s_stroke/);
  });
  // The bowls and the mirror check run on the SHIPPED WebP renders, decoded by
  // the browser: e2e/icon.spec.ts, "H1: the shipped renders' S".
});

describe("H4: weight", () => {
  it("keeps the hero frames at 6 MB or less", () => {
    const dir = join(root, "public", "hero");
    const files = readdirSync(dir).filter((f) => /^f-\d{3}\.webp$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(60);
    const bytes = files.reduce((n, f) => n + statSync(join(dir, f)).size, 0);
    expect(bytes).toBeLessThanOrEqual(6 * 1024 * 1024);
  });

  it("puts no frame in the page, and lazy-loads every image below the hero", () => {
    const html = readFileSync(join(root, "dist", "index.html"), "utf8");
    expect(html).not.toMatch(/src="\/hero\/f-/);
    const heroEnd = html.indexOf("</section>", html.indexOf('class="hero"'));
    const below = html.slice(heroEnd);
    const imgs = below.match(/<img\b[^>]*>/g) ?? [];
    expect(imgs.length).toBeGreaterThan(3);
    for (const img of imgs) expect(img, img).toMatch(/loading="lazy"/);
  });
});

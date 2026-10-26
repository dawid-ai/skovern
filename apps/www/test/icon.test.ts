import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPng } from "./png";

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

  it("has a bottom bowl at least as wide as the top bowl on the rendered front still", () => {
    const { width, height, rgba } = readPng(readFileSync(join(root, "art", "front-check.png")));
    // The glyph is the near-white ink in the middle of the tile (the glass rim's
    // highlights are near-white too, so look only at the centre).
    const x0 = Math.floor(width * 0.22), x1 = Math.ceil(width * 0.78);
    const y0 = Math.floor(height * 0.15), y1 = Math.ceil(height * 0.85);
    const rows: { y: number; w: number }[] = [];
    for (let y = y0; y < y1; y += 1) {
      let lo = -1, hi = -1;
      for (let x = x0; x < x1; x += 1) {
        const o = (y * width + x) * 4;
        const white = (rgba[o] ?? 0) > 225 && (rgba[o + 1] ?? 0) > 215 && (rgba[o + 2] ?? 0) > 200;
        if (white) {
          if (lo < 0) lo = x;
          hi = x;
        }
      }
      if (lo >= 0) rows.push({ y, w: hi - lo });
    }
    expect(rows.length).toBeGreaterThan(height * 0.2);
    const top = rows[0]!.y, bottom = rows.at(-1)!.y, mid = (top + bottom) / 2;
    const topBowl = Math.max(...rows.filter((r) => r.y < mid).map((r) => r.w));
    const bottomBowl = Math.max(...rows.filter((r) => r.y > mid).map((r) => r.w));
    // A typeface S is wider at the bottom. Strictly wider, because the old
    // hand-drawn S had two equal bowls (88 px and 88 px on this still) and read
    // as upside down.
    expect(bottomBowl).toBeGreaterThanOrEqual(topBowl);
    expect(bottomBowl).toBeGreaterThan(topBowl);
  });
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

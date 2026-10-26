import { expect, type Page } from "@playwright/test";

// Pixel and image helpers for e2e/icon.spec.ts. Everything here reads what is
// really on the canvas (getImageData) or in the shipped images, never only
// the canvas's own data-* report.

export const www = (): string => process.env["WWW_URL"] ?? "";

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export interface Drawn extends Rect {
  phase: string;
  frame: number;
}

export async function reported(page: Page): Promise<Drawn> {
  return page.evaluate(() => {
    const d = (document.querySelector("#icon-fly") as HTMLCanvasElement).dataset;
    const x = Number(d["x"]), y = Number(d["y"]), t = Number(d["tile"]);
    return { phase: d["phase"] ?? "", frame: Number(d["frame"]), left: x - t / 2, top: y - t / 2, right: x + t / 2, bottom: y + t / 2 };
  });
}

/** Fraction of canvas pixels with alpha > `min` inside `r` (CSS px), sampled. */
export async function inked(page: Page, r: Rect, min = 40): Promise<number> {
  return page.evaluate(
    ([r, min]) => {
      const c = document.querySelector("#icon-fly") as HTMLCanvasElement;
      const k = c.width / c.getBoundingClientRect().width;
      const x0 = Math.max(0, Math.floor(r.left * k)), y0 = Math.max(0, Math.floor(r.top * k));
      const x1 = Math.min(c.width, Math.ceil(r.right * k)), y1 = Math.min(c.height, Math.ceil(r.bottom * k));
      if (x1 <= x0 || y1 <= y0) return 0;
      const data = c.getContext("2d")!.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      let hit = 0, n = 0;
      for (let i = 3; i < data.length; i += 4 * 3) {
        n += 1;
        if ((data[i] ?? 0) > min) hit += 1;
      }
      return n ? hit / n : 0;
    },
    [r, min] as const,
  );
}

/** Count of inked canvas pixels OUTSIDE `r` grown by `margin` (CSS px), sampled. */
export async function strayInk(page: Page, r: Rect, margin: number, min = 40): Promise<number> {
  return page.evaluate(
    ([r, margin, min]) => {
      const c = document.querySelector("#icon-fly") as HTMLCanvasElement;
      const k = c.width / c.getBoundingClientRect().width;
      const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      const L = (r.left - margin) * k, T = (r.top - margin) * k, R = (r.right + margin) * k, B = (r.bottom + margin) * k;
      let stray = 0;
      for (let y = 0; y < c.height; y += 3) {
        for (let x = 0; x < c.width; x += 3) {
          if (x >= L && x <= R && y >= T && y <= B) continue;
          if ((data[(y * c.width + x) * 4 + 3] ?? 0) > min) stray += 1;
        }
      }
      return stray;
    },
    [r, margin, min] as const,
  );
}

/** A 24x24 grey thumbnail of the canvas inside `r`, for comparing poses. */
export async function thumb(page: Page, r: Rect): Promise<number[]> {
  return page.evaluate((r) => {
    const c = document.querySelector("#icon-fly") as HTMLCanvasElement;
    const k = c.width / c.getBoundingClientRect().width;
    const t = document.createElement("canvas");
    t.width = 24;
    t.height = 24;
    const g = t.getContext("2d")!;
    g.drawImage(c, r.left * k, r.top * k, (r.right - r.left) * k, (r.bottom - r.top) * k, 0, 0, 24, 24);
    const d = g.getImageData(0, 0, 24, 24).data;
    const out: number[] = [];
    for (let i = 0; i < d.length; i += 4) out.push(((d[i] ?? 0) + (d[i + 1] ?? 0) + (d[i + 2] ?? 0)) / 3);
    return out;
  }, r);
}
export const diff = (a: number[], b: number[]): number => a.reduce((s, v, i) => s + Math.abs(v - (b[i] ?? 0)), 0) / a.length;

/** Scroll instantly and wait for the icon to redraw in the expected phase. */
export async function scrollTo(page: Page, y: number, phase?: string): Promise<Drawn> {
  await page.evaluate((top) => {
    document.documentElement.style.scrollBehavior = "auto";
    window.scrollTo(0, top);
  }, y);
  if (phase) {
    await page.waitForFunction((p) => (document.querySelector("#icon-fly") as HTMLCanvasElement).dataset["phase"] === p, phase);
  }
  await page.waitForTimeout(250);
  return reported(page);
}

/** The four stops of the journey, in page coordinates. */
export async function stops(page: Page): Promise<{ dock: number; midFlight: number; receipts: number; waitlist: number }> {
  return page.evaluate(() => {
    const H = innerHeight;
    const abs = (sel: string): DOMRect => document.querySelector(sel)!.getBoundingClientRect();
    const win = abs("#f-win");
    const s0 = H * (innerWidth < 760 ? 0.8 : 0.95);
    const s1 = Math.min(s0 - 40, H * 0.5 - win.height * 0.5);
    const pin = abs("#rc-pin");
    const wl = abs("#waitlist");
    return {
      dock: Math.round(win.top + scrollY - s1 + 4),
      midFlight: Math.round(win.top + scrollY - (s0 + s1) / 2),
      receipts: Math.round(pin.top + scrollY + (pin.height - H) * 0.55),
      waitlist: Math.round(wl.top + scrollY - H * 0.25),
    };
  });
}

export async function open(page: Page): Promise<void> {
  await page.goto(`${www()}/`);
  await page.waitForFunction(() => document.documentElement.classList.contains("fly-on"));
  await scrollTo(page, 1);
  await scrollTo(page, 0);
  // The turntable frames load after the first scroll.
  await page.waitForFunction(
    () => performance.getEntriesByType("resource").filter((e) => /\/hero\/f-\d{3}\.webp/.test(e.name)).length >= 72,
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(300);
}

export const rectOf = async (page: Page, sel: string): Promise<Rect> => {
  const b = (await page.locator(sel).boundingBox())!;
  return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height };
};

/** The icon is really drawn in its reported box and nowhere well outside it. */
export async function expectDrawnAt(page: Page, at: Drawn, margin: number): Promise<void> {
  expect(await inked(page, shrink(at, 0.2)), `${at.phase}: ink inside the box`).toBeGreaterThan(0.6);
  expect(await strayInk(page, at, margin), `${at.phase}: stray ink outside`).toBe(0);
}
export const shrink = (r: Rect, f: number): Rect => {
  const w = (r.right - r.left) * f, h = (r.bottom - r.top) * f;
  return { left: r.left + w, top: r.top + h, right: r.right - w, bottom: r.bottom - h };
};


export interface GlyphMeasure {
  rows: number;
  topBowl: number;
  bottomBowl: number;
  slope: number;
}

/** Runs IN THE PAGE: decode a shipped image, find the S as the near-white ink
 *  inside the tile, and measure its bowls and the spine's slope, as shipped
 *  and mirrored. Self-contained, so page.evaluate can serialise it. */
export async function measureGlyph(url: string): Promise<{ shipped: GlyphMeasure; mirrored: GlyphMeasure }> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  // Measured as shipped, and once mirrored left to right: the mirror
  // check must tell the two apart.
  const measure = (mirrored: boolean) => {
    g.setTransform(mirrored ? -1 : 1, 0, 0, 1, mirrored ? c.width : 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0);
    const { data, width, height } = g.getImageData(0, 0, c.width, c.height);
    // The tile: the solid (alpha > 200) part of the image.
    let tl = width, tt = height, tr = 0, tb = 0;
    for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
      if ((data[(y * width + x) * 4 + 3] ?? 0) > 200) { tl = Math.min(tl, x); tr = Math.max(tr, x); tt = Math.min(tt, y); tb = Math.max(tb, y); }
    }
    const x0 = Math.round(tl + (tr - tl) * 0.18), x1 = Math.round(tr - (tr - tl) * 0.18);
    const y0 = Math.round(tt + (tb - tt) * 0.12), y1 = Math.round(tb - (tb - tt) * 0.12);
    const rows: { y: number; lo: number; hi: number; mean: number }[] = [];
    for (let y = y0; y < y1; y += 1) {
      let lo = -1, hi = -1, sum = 0, n = 0;
      for (let x = x0; x < x1; x += 1) {
        const o = (y * width + x) * 4;
        if ((data[o] ?? 0) > 225 && (data[o + 1] ?? 0) > 215 && (data[o + 2] ?? 0) > 200 && (data[o + 3] ?? 0) > 200) {
          if (lo < 0) lo = x;
          hi = x;
          sum += x;
          n += 1;
        }
      }
      if (n) rows.push({ y, lo, hi, mean: sum / n });
    }
    const top = rows[0]!.y, bottom = rows.at(-1)!.y, h = bottom - top, mid = top + h / 2;
    // The spine runs from upper left to lower right: across the middle
    // rows, the ink's centre moves right as it goes down. A mirrored S
    // (its top terminal opening left) runs the other way.
    const spine = rows.filter((r) => r.y >= top + h * 0.35 && r.y <= top + h * 0.65);
    const my = spine.reduce((s, r) => s + r.y, 0) / spine.length;
    const mx = spine.reduce((s, r) => s + r.mean, 0) / spine.length;
    const slope =
      spine.reduce((s, r) => s + (r.y - my) * (r.mean - mx), 0) / spine.reduce((s, r) => s + (r.y - my) ** 2, 0);
    return {
      rows: rows.length,
      topBowl: Math.max(...rows.filter((r) => r.y < mid).map((r) => r.hi - r.lo)),
      bottomBowl: Math.max(...rows.filter((r) => r.y > mid).map((r) => r.hi - r.lo)),
      slope,
    };
  };
  return { shipped: measure(false), mirrored: measure(true) };
}

import { expect, test, type Page } from "@playwright/test";

// H1 (the shipped renders' S), H2 (the journey at 1440), H3 (degraded states),
// H4 (no frame past 0 before a scroll). The flying icon is one canvas
// (#icon-fly). It reports where it drew in data-*, but every check here reads
// the canvas PIXELS: drawn inside the reported box, empty well outside it.

const www = (): string => process.env["WWW_URL"] ?? "";

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
interface Drawn extends Rect {
  phase: string;
  frame: number;
}

async function reported(page: Page): Promise<Drawn> {
  return page.evaluate(() => {
    const d = (document.querySelector("#icon-fly") as HTMLCanvasElement).dataset;
    const x = Number(d["x"]), y = Number(d["y"]), t = Number(d["tile"]);
    return { phase: d["phase"] ?? "", frame: Number(d["frame"]), left: x - t / 2, top: y - t / 2, right: x + t / 2, bottom: y + t / 2 };
  });
}

/** Fraction of canvas pixels with alpha > `min` inside `r` (CSS px), sampled. */
async function inked(page: Page, r: Rect, min = 40): Promise<number> {
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
async function strayInk(page: Page, r: Rect, margin: number, min = 40): Promise<number> {
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
async function thumb(page: Page, r: Rect): Promise<number[]> {
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
const diff = (a: number[], b: number[]): number => a.reduce((s, v, i) => s + Math.abs(v - (b[i] ?? 0)), 0) / a.length;

/** Scroll instantly and wait for the icon to redraw in the expected phase. */
async function scrollTo(page: Page, y: number, phase?: string): Promise<Drawn> {
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
async function stops(page: Page): Promise<{ dock: number; midFlight: number; receipts: number; waitlist: number }> {
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

async function open(page: Page): Promise<void> {
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

const rectOf = async (page: Page, sel: string): Promise<Rect> => {
  const b = (await page.locator(sel).boundingBox())!;
  return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height };
};

/** The icon is really drawn in its reported box and nowhere well outside it. */
async function expectDrawnAt(page: Page, at: Drawn, margin: number): Promise<void> {
  expect(await inked(page, shrink(at, 0.2)), `${at.phase}: ink inside the box`).toBeGreaterThan(0.6);
  expect(await strayInk(page, at, margin), `${at.phase}: stray ink outside`).toBe(0);
}
const shrink = (r: Rect, f: number): Rect => {
  const w = (r.right - r.left) * f, h = (r.bottom - r.top) * f;
  return { left: r.left + w, top: r.top + h, right: r.right - w, bottom: r.bottom - h };
};

test.describe("H2: the icon's journey at 1440", () => {
  test("spins, flies without its shadow, docks in the socket, centres the receipts, returns above the waitlist", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop-1440", "H2 runs at 1440");
    await open(page);
    const at = await stops(page);

    // Hero: drawn where reported (the floor shadow is allowed within 0.6 tile),
    // and two scroll positions show different poses: it spins.
    const h0 = await scrollTo(page, 0, "hero");
    const tile0 = h0.right - h0.left;
    await expectDrawnAt(page, h0, tile0 * 0.6);
    const a = await thumb(page, h0);
    const h1 = await scrollTo(page, 300, "hero");
    await expectDrawnAt(page, h1, (h1.right - h1.left) * 0.6);
    expect(h1.frame).toBeGreaterThan(h0.frame);
    expect(diff(a, await thumb(page, h1)), "hero poses differ").toBeGreaterThan(12);
    // ... and it drifts down at about half the scroll speed.
    expect((h1.top + h1.bottom) / 2 - (h0.top + h0.bottom) / 2).toBeGreaterThan(-300 * 0.65);

    // Mid-flight: the floor shadow is gone, so nothing smears outside the tile.
    const mid = await scrollTo(page, at.midFlight, "to-dock");
    await expectDrawnAt(page, mid, (mid.right - mid.left) * 0.12);

    // Docked: inside the socket (small tolerance), not over the chip's label.
    const dock = await scrollTo(page, at.dock, "dock");
    const sock = await rectOf(page, "#f-chip .socket");
    const tol = (sock.right - sock.left) * 0.1;
    await expectDrawnAt(page, dock, 2);
    expect(await strayInk(page, sock, tol), "docked ink outside the socket").toBe(0);
    await expect(page.locator("#f-chip")).toHaveClass(/docked/);

    // Receipts: centred on the orbit, 3+ cards around it, rocking with the orbit.
    const rc = await scrollTo(page, at.receipts, "receipts");
    const orbit = await rectOf(page, "#a-rc");
    expect(Math.abs((rc.left + rc.right) / 2 - (orbit.left + orbit.right) / 2)).toBeLessThan(4);
    expect(await inked(page, shrink(rc, 0.2))).toBeGreaterThan(0.6);
    const around = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("[data-c]")].filter((c) => {
        const r = c.getBoundingClientRect();
        return Number(getComputedStyle(c).opacity) > 0.4 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
      }).length,
    );
    expect(around).toBeGreaterThanOrEqual(3);
    const rc2 = await scrollTo(page, at.receipts + 260, "receipts");
    expect(rc2.frame).not.toBe(rc.frame);

    // Waitlist: drawn above the form, nothing on the form.
    const wl = await scrollTo(page, at.waitlist, "waitlist");
    const form = await rectOf(page, "#waitlist .wl");
    await expectDrawnAt(page, wl, 2);
    expect(wl.bottom).toBeLessThanOrEqual(form.top);
    expect(await inked(page, form, 10)).toBe(0);
  });
});

test.describe("H3: degraded states", () => {
  test("with reduced motion, a still icon shows in each place and nothing moves", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${www()}/`);
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => document.documentElement.classList.contains("fly-on"))).toBe(false);
    for (const sel of ["#a-hero .still", "#f-chip .socket .still", "#a-rc .still", "#a-wl .still"]) {
      const img = page.locator(sel);
      await img.scrollIntoViewIfNeeded();
      await expect(img).toBeVisible();
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
      expect(await img.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1);
    }
    expect(await page.locator("#icon-fly").evaluate((c: HTMLCanvasElement) => c.dataset["phase"] ?? "")).toBe("");
  });

  test("if the front still won't load, the stills stay and nothing flies", async ({ page }) => {
    await page.route("**/img/icon-front.webp", (r) => r.abort());
    await page.goto(`${www()}/`);
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => document.documentElement.classList.contains("fly-on"))).toBe(false);
    await expect(page.locator("#a-hero .still")).toBeVisible();
    expect(await page.locator("#a-hero .still").evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1);
  });

  test.describe("without JavaScript", () => {
    test.use({ javaScriptEnabled: false });
    test("shows the still hero icon", async ({ page }) => {
      await page.goto(`${www()}/`);
      const still = page.locator("#a-hero .still");
      await expect(still).toBeVisible();
      await expect.poll(() => still.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
    });
  });

  test("at 375, nothing scrolls sideways, the icon stays in view in flight, and its pixels cover no text", async ({ page }, info) => {
    test.skip(info.project.name !== "phone-375", "runs at 375");
    await open(page);
    const at = await stops(page);
    const noOverflow = async (): Promise<void> =>
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    const texts = (sel: string): Promise<Rect[]> =>
      page.evaluate((s) => [...document.querySelectorAll(s)].map((e) => {
        const r = e.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      }), sel);

    await scrollTo(page, 0, "hero");
    await noOverflow();
    for (const t of await texts(".hero h1, .hero .lede, .hero .eyebrow")) expect(await inked(page, t, 60), "hero text").toBe(0);

    const mid = await scrollTo(page, at.midFlight, "to-dock");
    expect(mid.top, "in flight, below the nav").toBeGreaterThanOrEqual(48 - 2);
    expect(await inked(page, shrink(mid, 0.2))).toBeGreaterThan(0.6);

    const dock = await scrollTo(page, at.dock, "dock");
    await noOverflow();
    const sock = await rectOf(page, "#f-chip .socket");
    await expectDrawnAt(page, dock, 2);
    expect(await strayInk(page, sock, (sock.right - sock.left) * 0.1)).toBe(0);

    await scrollTo(page, at.receipts, "receipts");
    await noOverflow();

    await scrollTo(page, at.waitlist, "waitlist");
    await noOverflow();
    for (const t of await texts("#waitlist h2, #waitlist .lede")) expect(await inked(page, t, 60), "waitlist text").toBe(0);
  });
});

test.describe("H4: frames wait for a scroll", () => {
  test("loads frame 0 and the stills up front, and no other frame until the person scrolls", async ({ page }) => {
    await page.goto(`${www()}/`);
    await page.waitForFunction(() => document.documentElement.classList.contains("fly-on"));
    await page.waitForTimeout(2000);
    const frameNames = (): Promise<string[]> =>
      page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /\/hero\/f-\d{3}\.webp/.test(n)));
    expect((await frameNames()).map((n) => n.slice(-10))).toEqual(["f-000.webp"]);
    await scrollTo(page, 40);
    await expect.poll(async () => (await frameNames()).length, { timeout: 30_000 }).toBe(72);
  });
});

test.describe("H1: the shipped renders' S", () => {
  // Each image is decoded by the browser (the shipped WebP), drawn to a canvas,
  // and the S is found as the near-white ink inside the tile.
  for (const src of ["/img/icon-front.webp", "/img/icon-front-dark.webp", "/hero/f-000.webp", "/hero/f-035.webp"]) {
    test(`${src}: the bottom bowl is wider than the top, and it isn't mirrored`, async ({ page }, info) => {
      test.skip(info.project.name !== "desktop-1440", "image checks run once");
      await page.goto(`${www()}/404`);
      const m = await page.evaluate(async (url) => {
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
      }, src);
      const { shipped, mirrored } = m;
      expect(shipped.rows).toBeGreaterThan(20);
      expect(shipped.bottomBowl, `bowls ${shipped.topBowl} / ${shipped.bottomBowl}`).toBeGreaterThan(shipped.topBowl);
      expect(shipped.slope, "the spine runs upper left to lower right").toBeGreaterThan(0);
      expect(mirrored.slope, "a mirrored S runs the other way").toBeLessThan(0);
    });
  }
});

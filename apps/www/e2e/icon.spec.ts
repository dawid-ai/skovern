import { expect, test, type Page } from "@playwright/test";
import {
  diff,
  expectDrawnAt,
  inked,
  open,
  rectOf,
  screenChange,
  scrollTo,
  shrink,
  stops,
  strayInk,
  thumb,
  www,
  measureGlyph,
  measureTile,
  type Rect,
} from "./pixels";

// H1 + P1 (the shipped renders' S), H2 (the journey at 1440), H3 (degraded
// states), H4 (only the sway's frames before a scroll), P2 (idle motion, in
// Chromium, Firefox, and WebKit: see playwright.config.ts). The flying icon is one canvas
// (#icon-fly). It reports where it drew in data-*, but every check here reads
// the canvas PIXELS (helpers in ./pixels): drawn inside the reported box, empty
// well outside it.

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
    // ... and it lags the page (drifting at about half speed, or shrinking as
    // it nears the headline) instead of scrolling away at full speed.
    const lag = (h1.top + h1.bottom) / 2 - (h0.top + h0.bottom) / 2 + 300;
    const shrunk = h1.right - h1.left < (h0.right - h0.left) * 0.98;
    expect(lag > 300 * 0.3 || shrunk, `lag ${lag.toFixed(0)} px, shrunk ${shrunk}`).toBe(true);

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

test.describe("H3: the hero icon never sits on the headline", () => {
  // Sweep the hero's whole scroll range: at every 50 px, under 1% of the h1's
  // and the lede's pixels may sit under solid icon ink (alpha > 200), at both
  // widths. The drift is clamped 16 px above the copy, shadow included.
  test("sweeps the hero in 50 px steps", async ({ page }) => {
    await open(page);
    const end = await page.evaluate(() => {
      const r = document.querySelector(".hero")!.getBoundingClientRect();
      return Math.round(r.bottom + scrollY);
    });
    const worst: string[] = [];
    for (let y = 0; y <= end; y += 50) {
      const at = await scrollTo(page, y);
      if (at.phase !== "hero") break;
      for (const sel of [".hero h1", ".hero .lede"]) {
        const r = await rectOf(page, sel);
        const covered = await inked(page, r, 200);
        if (covered >= 0.01) worst.push(`${sel} at ${y}px: ${(covered * 100).toFixed(1)}%`);
      }
    }
    expect(worst, "text under solid icon ink").toEqual([]);
  });
});

// The idle sway steps through frames 1..14 (SWAY in icon-flight.ts).
const SWAY = 14;

test.describe("H4: frames wait for a scroll", () => {
  test("loads frame 0, the stills, and the sway's frames up front, and no other frame until the person scrolls", async ({ page }) => {
    await page.goto(`${www()}/`);
    await page.waitForFunction(() => document.documentElement.classList.contains("fly-on"));
    await page.waitForTimeout(3000);
    const frameNames = (): Promise<string[]> =>
      page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /\/hero\/f-\d{3}\.webp/.test(n)));
    const want = Array.from({ length: SWAY + 1 }, (_, i) => `f-${String(i).padStart(3, "0")}.webp`);
    expect((await frameNames()).map((n) => n.slice(-10)).sort()).toEqual(want);
    await scrollTo(page, 40);
    await expect.poll(async () => (await frameNames()).length, { timeout: 30_000 }).toBe(72);
  });
});

test.describe("H1 + P1: the shipped renders' S", () => {
  // Each image is decoded by the browser (the shipped WebP), drawn to a canvas,
  // and the S is found as the near-white ink inside the tile. P1: the camera
  // looks down on a tile that leans back, so at every turntable frame the
  // bottom bowl renders at least as wide as the top (perspective used to make
  // the top one bigger, and the S read upside down).
  const turn = ["000", "018", "035", "053", "071"].map((f) => `/hero/f-${f}.webp`);
  for (const src of ["/img/icon-front.webp", "/img/icon-front-dark.webp", "/img/icon-still.webp", ...turn]) {
    test(`${src}: the bottom bowl is wider than the top, and it isn't mirrored`, async ({ page }, info) => {
      test.skip(info.project.name !== "desktop-1440", "image checks run once");
      await page.goto(`${www()}/404`);
      const m = await page.evaluate(measureGlyph, src);
      const { shipped, mirrored } = m;
      expect(shipped.rows).toBeGreaterThan(20);
      expect(shipped.bottomBowl, `bowls ${shipped.topBowl} / ${shipped.bottomBowl}`).toBeGreaterThan(shipped.topBowl);
      expect(shipped.slope, "the spine runs upper left to lower right").toBeGreaterThan(0);
      expect(mirrored.slope, "a mirrored S runs the other way").toBeLessThan(0);
    });
  }
  // The bowls alone didn't catch loop 053's renders (bottom 3% wider, yet the
  // icon read upside down): the whole tile was drawn wider at the top. Seen
  // from above, the tile's bottom edge is at least as wide as its top.
  for (const src of turn) {
    test(`${src}: the camera looks down, so the tile is no wider at the top than at the bottom`, async ({ page }, info) => {
      test.skip(info.project.name !== "desktop-1440", "image checks run once");
      await page.goto(`${www()}/404`);
      const t = await page.evaluate(measureTile, src);
      expect(t.top).toBeGreaterThan(100);
      expect(t.bottom, `tile ${t.top} at the top, ${t.bottom} at the bottom`).toBeGreaterThanOrEqual(t.top);
    });
  }
});

test.describe("P2: the hero icon moves on its own at rest", () => {
  // Real screen pixels (a screenshot, decoded), so this means the same thing in
  // Chromium, Firefox, and WebKit: the share of pixels in the hero icon's box
  // that changed by more than 24 (of 255) in some channel.
  const changed = (page: Page, r: Rect): Promise<number> => screenChange(page, r, 1000);
  test("after 2 s with no scrolling, two crops 1 s apart differ, and it turns through the frames", async ({ page }) => {
    await page.goto(`${www()}/`);
    await page.waitForFunction(() => document.documentElement.classList.contains("fly-on"));
    await page.waitForTimeout(2000);
    const moved = await changed(page, await rectOf(page, "#a-hero"));
    expect(moved, "share of the hero icon's pixels that changed in 1 s at rest").toBeGreaterThan(0.005);
    // The sway: over 4 s at rest the drawn frame changes, without a scroll.
    const seen = new Set<number>();
    for (let i = 0; i < 8; i += 1) {
      seen.add(await page.evaluate(() => Number((document.querySelector("#icon-fly") as HTMLCanvasElement).dataset["frame"])));
      await page.waitForTimeout(500);
    }
    expect(seen.size, `frames seen at rest: ${[...seen].join(", ")}`).toBeGreaterThanOrEqual(3);
    expect(Math.max(...seen)).toBeLessThanOrEqual(SWAY);
  });

  // Phone data: the sway's frames are the only ones fetched before a scroll,
  // and not even those when the reader asks to save data or for less motion.
  for (const mode of ["save-data", "reduced motion"] as const) {
    test(`with ${mode}, no frame past f-000 is fetched before a scroll`, async ({ page }) => {
      test.setTimeout(120_000);
      if (mode === "save-data") {
        await page.addInitScript(() => {
          Object.defineProperty(Navigator.prototype, "connection", { configurable: true, get: () => ({ saveData: true }) });
        });
      } else {
        await page.emulateMedia({ reducedMotion: "reduce" });
      }
      await page.goto(`${www()}/`);
      if (mode === "save-data") await page.waitForFunction(() => document.documentElement.classList.contains("fly-on"));
      await page.waitForTimeout(3000);
      const names = await page.evaluate(() =>
        performance.getEntriesByType("resource").map((e) => e.name.slice(-10)).filter((n) => /^f-\d{3}\.webp$/.test(n)),
      );
      expect(names.filter((n) => n !== "f-000.webp")).toEqual([]);
      if (mode === "save-data") {
        // ... and it still moves at rest, with the bob alone, on frame 0. A bob
        // moves slowest at its top and bottom, so take the most it moved in any
        // of three 1 s windows.
        const r = await rectOf(page, "#a-hero");
        let most = 0;
        for (let i = 0; i < 3; i += 1) most = Math.max(most, await changed(page, r));
        expect(most, "share of pixels the bob moved in its liveliest second").toBeGreaterThan(0.002);
        expect(await page.evaluate(() => (document.querySelector("#icon-fly") as HTMLCanvasElement).dataset["frame"])).toBe("0");
      }
    });
  }

  test("under reduced motion, two crops 1 s apart are identical", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${www()}/`);
    const still = page.locator("#a-hero .still");
    await expect.poll(() => still.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
    await page.waitForTimeout(2000);
    expect(await changed(page, await rectOf(page, "#a-hero"))).toBe(0);
  });
});

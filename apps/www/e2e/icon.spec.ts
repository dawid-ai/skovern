import { expect, test, type Page } from "@playwright/test";

// H2 (the icon's journey at 1440) and H3 (reduced motion, no JavaScript, 375).
// The flying icon is one canvas (#icon-fly); it publishes where it drew the
// glass tile in data-x / data-y / data-tile, and which turntable frame in data-frame.

const www = (): string => process.env["WWW_URL"] ?? "";

interface Drawn {
  phase: string;
  frame: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

async function drawn(page: Page): Promise<Drawn> {
  return page.evaluate(() => {
    const d = (document.querySelector("#icon-fly") as HTMLCanvasElement).dataset;
    const x = Number(d["x"]), y = Number(d["y"]), t = Number(d["tile"]);
    return { phase: d["phase"] ?? "", frame: Number(d["frame"]), left: x - t / 2, top: y - t / 2, right: x + t / 2, bottom: y + t / 2 };
  });
}

/** Scroll instantly and wait for the icon to redraw in the expected phase. */
async function scrollTo(page: Page, y: number, phase?: string): Promise<Drawn> {
  await page.evaluate((top) => {
    document.documentElement.style.scrollBehavior = "auto";
    window.scrollTo(0, top);
  }, y);
  if (phase) {
    await page.waitForFunction((p) => (document.querySelector("#icon-fly") as HTMLCanvasElement).dataset["phase"] === p, phase);
  }
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return drawn(page);
}

/** The four stops of the journey, in page coordinates. */
async function stops(page: Page): Promise<{ hero: number; dock: number; receipts: number; waitlist: number }> {
  return page.evaluate(() => {
    const H = innerHeight;
    const abs = (sel: string): DOMRect => document.querySelector(sel)!.getBoundingClientRect();
    const win = abs("#f-win");
    const s1 = Math.min(H * (innerWidth < 760 ? 0.8 : 0.95) - 40, H * 0.5 - win.height * 0.5);
    const pin = abs("#rc-pin");
    const wl = abs("#waitlist");
    return {
      hero: 0,
      dock: Math.round(win.top + scrollY - s1 + 4),
      receipts: Math.round(pin.top + scrollY + (pin.height - H) * 0.55),
      waitlist: Math.round(wl.top + scrollY - H * 0.25),
    };
  });
}

async function open(page: Page): Promise<void> {
  await page.goto(`${www()}/`);
  await page.waitForFunction(() => document.documentElement.classList.contains("fly-on"));
  // Let the turntable frames arrive (they load after the page).
  await page.waitForTimeout(1500);
}

const inside = (a: { left: number; top: number; right: number; bottom: number }, b: DOMRect | { left: number; top: number; right: number; bottom: number }, slack = 2): boolean =>
  a.left >= b.left - slack && a.top >= b.top - slack && a.right <= b.right + slack && a.bottom <= b.bottom + slack;

test.describe("H2: the icon's journey at 1440", () => {
  test("spins in the hero, docks in the brain chip, centres the receipts, and returns above the waitlist", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop-1440", "H2 runs at 1440");
    await open(page);
    const at = await stops(page);

    const h0 = await scrollTo(page, 0, "hero");
    const h1 = await scrollTo(page, 260, "hero");
    expect(h0.frame).toBe(0);
    expect(h1.frame).toBeGreaterThan(h0.frame);

    const dock = await scrollTo(page, at.dock, "dock");
    const chip = await page.locator("#f-chip").boundingBox();
    expect(chip).not.toBeNull();
    expect(inside(dock, { left: chip!.x, top: chip!.y, right: chip!.x + chip!.width, bottom: chip!.y + chip!.height })).toBe(true);
    await expect(page.locator("#f-chip")).toHaveClass(/docked/);

    const rc = await scrollTo(page, at.receipts, "receipts");
    const around = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("[data-c]")].filter((c) => {
        const r = c.getBoundingClientRect();
        return Number(getComputedStyle(c).opacity) > 0.4 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
      }).length,
    );
    expect(around).toBeGreaterThanOrEqual(3);
    const orbit = await page.locator("#a-rc").boundingBox();
    expect(Math.abs(rc.left + (rc.right - rc.left) / 2 - (orbit!.x + orbit!.width / 2))).toBeLessThan(4);

    const wl = await scrollTo(page, at.waitlist, "waitlist");
    const form = await page.locator("#waitlist .wl").boundingBox();
    expect(wl.bottom).toBeLessThanOrEqual(form!.y);
    expect(wl.top).toBeGreaterThan(0);
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

  test.describe("without JavaScript", () => {
    test.use({ javaScriptEnabled: false });
    test("shows the still hero icon", async ({ page }) => {
      await page.goto(`${www()}/`);
      const still = page.locator("#a-hero .still");
      await expect(still).toBeVisible();
      await expect.poll(() => still.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
    });
  });

  test("at 375, nothing scrolls sideways and the icon covers no text at its stops", async ({ page }, info) => {
    test.skip(info.project.name !== "phone-375", "runs at 375");
    await open(page);
    const at = await stops(page);
    const noOverflow = async (): Promise<void> =>
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    const textBoxes = (sel: string) =>
      page.evaluate((s) => [...document.querySelectorAll(s)].map((e) => e.getBoundingClientRect().toJSON() as DOMRect), sel);
    const overlaps = (a: Drawn, b: DOMRect): boolean => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

    const hero = await scrollTo(page, at.hero, "hero");
    await noOverflow();
    for (const t of await textBoxes(".hero h1, .hero .lede, .hero .eyebrow")) expect(overlaps(hero, t)).toBe(false);

    const dock = await scrollTo(page, at.dock, "dock");
    await noOverflow();
    const chip = await page.locator("#f-chip").boundingBox();
    expect(inside(dock, { left: chip!.x, top: chip!.y, right: chip!.x + chip!.width, bottom: chip!.y + chip!.height })).toBe(true);

    await scrollTo(page, at.receipts, "receipts");
    await noOverflow();

    const wl = await scrollTo(page, at.waitlist, "waitlist");
    await noOverflow();
    for (const t of await textBoxes("#waitlist h2, #waitlist .lede")) expect(overlaps(wl, t)).toBe(false);
  });
});

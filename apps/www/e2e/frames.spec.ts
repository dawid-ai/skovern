import { expect, test, type Page } from "@playwright/test";
import { rectOf, screenPixels, www } from "./pixels";

// P3 (loop 054): every app screenshot on skovern.com sits in a window frame
// with design A's rounded corners (18 px at full size, 12 px or more always),
// and the frame clips the image so its square corners never show. Runs in
// Chromium, Firefox, and WebKit (playwright.config.ts).

interface Frame {
  src: string;
  radius: number;
  clips: boolean;
}

/** Every app screenshot on the page, with its frame: the nearest ancestor that
 *  clips it (overflow or clip-path), and that frame's smallest corner radius. */
async function frames(page: Page): Promise<Frame[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLImageElement>('img[src*="/img/app-"]')].map((img) => {
      const clipsOf = (cs: CSSStyleDeclaration): boolean =>
        cs.overflowX === "hidden" || cs.overflowX === "clip" || cs.clipPath !== "none";
      let f: Element | null = img.parentElement;
      while (f && f !== document.body && !clipsOf(getComputedStyle(f))) f = f.parentElement;
      if (!f || f === document.body) return { src: img.getAttribute("src") ?? "", radius: 0, clips: false };
      const cs = getComputedStyle(f);
      const radius = Math.min(...[cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomLeftRadius, cs.borderBottomRightRadius].map((v) => parseFloat(v)));
      return { src: img.getAttribute("src") ?? "", radius, clips: true };
    }),
  );
}

const expectRounded = (list: Frame[], where: string): void => {
  for (const f of list) {
    expect(f.radius, `${where} ${f.src}: corner radius`).toBeGreaterThanOrEqual(12);
    expect(f.clips, `${where} ${f.src}: the frame clips the image`).toBe(true);
  }
};

test.describe("P3: rounded screenshot frames", () => {
  test("home: the app window is rounded, 18 px at 1440, and clips its screenshot", async ({ page }, info) => {
    await page.goto(`${www()}/`);
    const list = await frames(page);
    expect(list.length, "app screenshots on /").toBeGreaterThan(0);
    expectRounded(list, "/");
    const win = await page.locator("#f-win").evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius));
    expect(win).toBeGreaterThanOrEqual(12);
    if (info.project.name.endsWith("1440")) expect(win, "full size: design A's 18 px").toBe(18);
  });

  test("blog and post pages: every screenshot frame, including the card crops, is rounded and clips", async ({ page }) => {
    await page.goto(`${www()}/blog/`);
    const post = await page.locator("a[href^='/blog/']").evaluateAll((as) =>
      as.map((a) => a.getAttribute("href") ?? "").find((h) => /^\/blog\/[^/]+\/$/.test(h)),
    );
    expectRounded(await frames(page), "/blog/");
    // A screenshot card crop (Cover.astro, cover: chat) built with the page's
    // own CSS: today's one post has an icon cover, so no crop ships yet.
    await page.evaluate(() => {
      const host = document.querySelector("main") ?? document.body;
      host.insertAdjacentHTML(
        "beforeend",
        '<div class="cover cv-grey" style="width:360px"><picture class="frame shot"><img src="/img/app-chat-light.webp" alt="" width="1600" height="1047"></picture></div>',
      );
    });
    const crop = await frames(page);
    expect(crop.length).toBeGreaterThan(0);
    expectRounded(crop, "/blog/ card crop");
    expect(post, "a post link on /blog/").toBeTruthy();
    await page.goto(`${www()}${post!}`);
    expectRounded(await frames(page), post!);
  });

  test("the app window's top-left corner shows the page, not the screenshot", async ({ page }) => {
    await page.goto(`${www()}/`);
    const win = page.locator("#f-win");
    await win.scrollIntoViewIfNeeded();
    const img = win.locator("picture img");
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
    await page.waitForTimeout(1200); // reveals and the window's entrance settle
    const r = await rectOf(page, "#f-win");
    // The screenshot's own top-left pixel, decoded from the file the page shows.
    const own = await img.evaluate(async (el: HTMLImageElement) => {
      const c = document.createElement("canvas");
      c.width = el.naturalWidth;
      c.height = el.naturalHeight;
      const g = c.getContext("2d")!;
      g.drawImage(el, 0, 0);
      return [...g.getImageData(3, 3, 1, 1).data].slice(0, 3);
    });
    // On screen: a 24 px patch at the window's corner; (2, 2) inside the window,
    // and the page just above the window (clear of its shadow, under the lede).
    const shot = await screenPixels(page, { left: r.left, top: r.top, right: r.left + 24, bottom: r.top + 24 });
    const at = (x: number, y: number): number[] => shot.data.slice((y * shot.w + x) * 4, (y * shot.w + x) * 4 + 3);
    const corner = at(2, 2);
    const page0 = (await screenPixels(page, { left: r.left + 60, top: r.top - 40, right: r.left + 70, bottom: r.top - 30 })).data.slice(0, 3);
    const dist = (a: number[], b: number[]): number => Math.hypot(...a.map((v, i) => v - (b[i] ?? 0)));
    expect(dist(own, page0), "the screenshot's corner and the page differ, so the test can tell").toBeGreaterThan(12);
    expect(dist(corner, page0), `corner ${corner} vs page ${page0} vs image ${own}`).toBeLessThan(dist(corner, own));
  });
});

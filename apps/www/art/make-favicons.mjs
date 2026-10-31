// Draws the flat Skovern mark (orange rounded square, white Inter Bold "S") into
// the site's favicons with Playwright's Chromium, using the same self-hosted
// Inter the site ships. Run from apps/www:  node art/make-favicons.mjs
// Writes public/favicon.png (48), public/favicon-32.png (32), and
// public/apple-touch-icon.png (180, square: iOS rounds it). The committed PNGs
// are what ships; this script is how they were made.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "..", "public");
const font = readFileSync(
  join(here, "..", "node_modules", "@fontsource-variable", "inter", "files", "inter-latin-wght-normal.woff2"),
).toString("base64");

const page = (size, radius) => `<!doctype html><html><head><style>
@font-face { font-family: InterMark; src: url(data:font/woff2;base64,${font}) format("woff2"); font-weight: 100 900; }
html, body { margin: 0; background: transparent; }
.m { width: ${size}px; height: ${size}px; border-radius: ${radius}px; display: grid; place-items: center;
  background: linear-gradient(150deg, #f3a15f, #e87a2e 60%, #c25a1c); color: #fff;
  font: 700 ${Math.round(size * 0.68)}px/1 InterMark; letter-spacing: 0; }
.m span { transform: translateY(-3%); }
</style></head><body><div class="m"><span>S</span></div></body></html>`;

const browser = await chromium.launch();
for (const [file, size, radius] of [["favicon.png", 48, 11], ["favicon-32.png", 32, 7], ["apple-touch-icon.png", 180, 0]]) {
  const p = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await p.setContent(page(size, radius));
  await p.evaluate(() => document.fonts.ready);
  writeFileSync(join(pub, file), await p.locator(".m").screenshot({ omitBackground: true }));
  await p.close();
}
await browser.close();
console.log("favicons written");

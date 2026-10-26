// Renders the Skovern mark (the orange rounded square with a white "S", design A, loop 049) into
// the app icons: icon.png (512), icon.ico (256/128/64/48/32/16, PNG-compressed entries), and the
// tray icons tray.png (16) + tray@2x.png (32). Run from apps/desktop:
//   node build/make-icons.mjs
// It draws with Playwright's Chromium (or Edge), so the output is a plain bitmap; the committed
// PNG/ICO files are what ships, this script is only how they were made.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const dir = path.dirname(fileURLToPath(import.meta.url));

// `inset` leaves a margin on big icons (they sit next to other app icons); the tray fills its box.
function svg(inset) {
  const s = 512 - inset * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="g" x1="0.15" y1="0" x2="0.85" y2="1">
      <stop offset="0" stop-color="#f3a15f"/>
      <stop offset="0.6" stop-color="#e87a2e"/>
      <stop offset="1" stop-color="#c25a1c"/>
    </linearGradient>
  </defs>
  <rect x="${inset}" y="${inset}" width="${s}" height="${s}" rx="${s * 0.235}" fill="url(#g)"/>
  <text x="256" y="${256 + s * 0.235}" text-anchor="middle" fill="#fff"
    font-family="'Segoe UI Variable Display','Segoe UI',-apple-system,Arial,sans-serif" font-weight="700"
    font-size="${s * 0.66}">S</text>
</svg>`;
}

async function render(browser, markup, size) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${markup.replace('width="512" height="512"', `width="${size}" height="${size}"`)}</body></html>`,
  );
  const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
  return png;
}

// An ICO whose entries are PNGs (valid on Windows Vista and later; electron-builder accepts it).
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

let browser;
try {
  browser = await chromium.launch();
} catch {
  browser = await chromium.launch({ channel: "msedge" });
}
try {
  const app = svg(20);
  const tray = svg(0);
  writeFileSync(path.join(dir, "icon.svg"), app);
  writeFileSync(path.join(dir, "icon.png"), await render(browser, app, 512));
  const sizes = [256, 128, 64, 48, 32, 16];
  const images = [];
  for (const size of sizes) images.push({ size, png: await render(browser, size <= 32 ? tray : app, size) });
  writeFileSync(path.join(dir, "icon.ico"), ico(images));
  writeFileSync(path.join(dir, "tray.png"), await render(browser, tray, 16));
  writeFileSync(path.join(dir, "tray@2x.png"), await render(browser, tray, 32));
  console.log("wrote icon.svg, icon.png, icon.ico, tray.png, tray@2x.png");
} finally {
  await browser.close();
}

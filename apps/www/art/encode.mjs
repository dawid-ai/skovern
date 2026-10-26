// Turn the Blender PNG renders into the web assets the site ships.
//
//   node apps/www/art/encode.mjs <render dir>
//
// <render dir> holds what icon.py wrote: frames/f-NNN.png, still.png, front.png,
// front-dark.png, og.png. Needs ffmpeg with libwebp on PATH. Writes into apps/www/public.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const src = process.argv[2];
if (!src) {
  console.error("usage: node apps/www/art/encode.mjs <render dir>");
  process.exit(1);
}
const pub = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
mkdirSync(join(pub, "hero"), { recursive: true });
mkdirSync(join(pub, "img"), { recursive: true });

const ff = (...args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
// Lossy WebP with alpha. 1200 px at quality 80 is about 57 KB a frame, ~4 MB for 72.
// `vignette`: the shadow catcher also records faint floor occlusion out to the canvas edge,
// which would print a visible box on the page. A radial alpha mask fades it to 0 by the
// edge; the icon sits well inside the fully opaque middle of the mask.
const VIGNETTE = "geq=lum='255*clip((0.49-hypot(X-W/2,Y-H/2)/W)/0.09,0,1)'";
const webp = (input, output, quality, vignette = false) =>
  ff("-i", input,
    ...(vignette
      ? ["-filter_complex", `[0]format=rgba,split[c][x];[x]alphaextract,split[a][g];[g]${VIGNETTE}[m];[a][m]blend=all_mode=multiply[am];[c][am]alphamerge`]
      : []),
    "-c:v", "libwebp", "-lossless", "0", "-quality", String(quality),
    "-compression_level", "6", "-pix_fmt", "yuva420p", output);

const frames = readdirSync(join(src, "frames")).filter((f) => /^f-\d{3}\.png$/.test(f)).sort();
for (const f of frames) webp(join(src, "frames", f), join(pub, "hero", f.replace(".png", ".webp")), 80, true);
webp(join(src, "still.png"), join(pub, "img", "icon-still.webp"), 88, true);
webp(join(src, "front.png"), join(pub, "img", "icon-front.webp"), 88);
webp(join(src, "front-dark.png"), join(pub, "img", "icon-front-dark.webp"), 88);
// A small PNG of the front still, kept next to the script for the H1 glyph test
// (test/icon.test.ts measures the S's bowls from it).
ff("-i", join(src, "front.png"), "-vf", "scale=256:256", "-pix_fmt", "rgba", join(dirname(fileURLToPath(import.meta.url)), "front-check.png"));
// The Open Graph card is opaque: flatten the transparent render onto the stage grey.
ff("-f", "lavfi", "-i", "color=c=0xf5f5f7:s=1200x630", "-i", join(src, "og.png"),
  "-filter_complex", "[0][1]overlay=format=auto,format=rgb24", "-frames:v", "1", join(pub, "og.png"));
console.log(`encoded ${frames.length} frames + stills into ${pub}`);

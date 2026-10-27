// The hero icon's journey down the home page (round-3 demo, loop 053), drawn
// from the Cycles renders on one fixed canvas over the page:
//   1. hero: the 72-frame turntable scrubs with scroll while the icon drifts at
//      about half speed, so you watch it turn; it floats gently when idle;
//   2. "It stays home": it flies into the app window's brain chip and docks;
//   3. receipts: it sits in the centre of the orbiting cards, rocking with them;
//   4. waitlist: it settles above the form, floating again.
// The anchors (#a-hero, .socket, #a-rc, #a-wl) keep still images; they show
// whenever this doesn't run (reduced motion, no canvas, an image that won't
// load, no JavaScript) and hide only once every image it needs has decoded.
// Tests read the canvas's data-* attributes AND its pixels.

const FRAME_FILL = 0.45; // the tile spans ~45% of a turntable frame's width
const STILL_FILL = 0.88; // ... and ~88% of a front still's width
/** Where the tile sits inside a turntable frame, across all 72 (fractions of
 *  the frame): the floor shadow lies outside it, below and to the right. */
const TILE_IN_FRAME = { left: 0.24, top: 0.2, right: 0.77, bottom: 0.735 };
const NAV = 48;

const clamp = (v: number, a = 0, b = 1): number => Math.min(b, Math.max(a, v));
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const pad = (n: number): string => String(n).padStart(3, "0");

interface Box {
  x: number;
  y: number;
  /** Width of the TILE (the glass square) at this anchor, in CSS px. */
  tile: number;
}

function box(el: Element, fill: number, k = 1): Box {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, tile: r.width * fill * k };
}

/** Load and decode an image; null if it fails. */
async function loadImage(src: string): Promise<HTMLImageElement | null> {
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
    return img;
  } catch {
    return null;
  }
}

export function startIconFlight(): void {
  const canvas = document.querySelector<HTMLCanvasElement>("#icon-fly");
  const hero = document.querySelector<HTMLElement>("#a-hero");
  const heroCopy = document.querySelector<HTMLElement>(".hero .copy");
  const socket = document.querySelector<HTMLElement>("#f-chip .socket");
  const chip = document.querySelector<HTMLElement>("#f-chip");
  const win = document.querySelector<HTMLElement>("#f-win");
  const rc = document.querySelector<HTMLElement>("#a-rc");
  const pin = document.querySelector<HTMLElement>("#rc-pin");
  const wl = document.querySelector<HTMLElement>("#a-wl");
  const wlSec = document.querySelector<HTMLElement>("#waitlist");
  const count = Number(hero?.dataset["frames"] ?? 0);
  if (!canvas || !hero || !heroCopy || !socket || !chip || !win || !rc || !pin || !wl || !wlSec || count < 2) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const ctx = canvas.getContext("2d");
  const off = document.createElement("canvas").getContext("2d");
  if (!ctx || !off) return;

  const frames: (HTMLImageElement | null)[] = new Array<HTMLImageElement | null>(count).fill(null);
  let front: HTMLImageElement | null = null;
  // The frame that faces the camera most squarely: the docked pose blends into it.
  const FACE = Math.round((count - 1) * 0.46);
  let queued = false;
  let started = false;
  let floating = false;
  let cssW = 1;
  let cssH = 1;

  // The canvas is position:fixed with inset:0, so its own box is the visible
  // viewport (mobile toolbars included); size the buffer from that box.
  const size = (): void => {
    const r = canvas.getBoundingClientRect();
    cssW = Math.max(1, r.width);
    cssH = Math.max(1, r.height);
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(canvas.width / cssW, 0, 0, canvas.height / cssH, 0, 0);
  };

  const nearest = (want: number): HTMLImageElement | null => {
    for (let d = 0; d < count; d += 1) {
      const a = frames[want - d] ?? null;
      if (a) return a;
      const b = frames[want + d] ?? null;
      if (b) return b;
    }
    return null;
  };

  /** Draw an image so its tile is `tile` px wide, centred at (x, y). */
  const put = (img: HTMLImageElement | null, x: number, y: number, tile: number, fill: number, alpha: number): void => {
    if (!img || alpha <= 0.002 || tile <= 0) return;
    const s = tile / fill;
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.drawImage(img, x - s / 2, y - s / 2, s, s);
  };

  /** Draw a turntable frame with its floor shadow faded by `noShadow` (0..1):
   *  the frame goes through a scratch canvas clipped to the tile. */
  const putFrame = (img: HTMLImageElement | null, x: number, y: number, tile: number, alpha: number, noShadow: number): void => {
    if (!img || alpha <= 0.002) return;
    if (noShadow <= 0) return put(img, x, y, tile, FRAME_FILL, alpha);
    put(img, x, y, tile, FRAME_FILL, alpha * (1 - noShadow));
    const s = tile / FRAME_FILL;
    const px = Math.max(1, Math.round(s));
    if (off.canvas.width !== px) {
      off.canvas.width = px;
      off.canvas.height = px;
    }
    off.clearRect(0, 0, px, px);
    off.save();
    off.beginPath();
    const t = TILE_IN_FRAME;
    off.roundRect(t.left * px, t.top * px, (t.right - t.left) * px, (t.bottom - t.top) * px, px * 0.06);
    off.clip();
    off.drawImage(img, 0, 0, px, px);
    off.restore();
    ctx.globalAlpha = Math.min(1, alpha * noShadow);
    ctx.drawImage(off.canvas, x - s / 2, y - s / 2, s, s);
  };

  const draw = (now: number): void => {
    queued = false;
    const H = cssH;
    const narrow = cssW < 760;
    const heroRect = hero.getBoundingClientRect();
    const heroB = box(hero, FRAME_FILL);
    const dockB = box(socket, STILL_FILL, 1.08);
    const rcB = box(rc, STILL_FILL);
    const wlB = box(wl, STILL_FILL);
    // Hero: the icon drifts down at about half the scroll speed (as in the
    // demo), and the turn completes as it reaches the top of the screen.
    // ... but never into the headline: the frame's lowest ink (the floor
    // shadow, ~0.32 of a frame below the tile's centre, plus the idle float)
    // stays 16 px above the hero copy. Near the copy the icon shrinks (down to
    // half size, as if moving away) instead of overlapping; past that it
    // scrolls with the page.
    const inkBelow = 0.32 / FRAME_FILL + 0.02; // lowest ink, per px of tile, below the centre
    const limit = heroCopy.getBoundingClientRect().top - 16;
    const drifted = heroB.y + scrollY * 0.45;
    heroB.tile = clamp((limit - drifted) / inkBelow, heroB.tile * 0.5, heroB.tile);
    heroB.y = Math.min(drifted, limit - inkBelow * heroB.tile);
    const spin = clamp(scrollY / Math.max(1, (heroRect.top + scrollY + heroRect.height * 0.45) / 0.55));
    const heroIdx = Math.round(spin * (count - 1));
    const bob = Math.sin((now / 1000) * ((Math.PI * 2) / 5.5));
    // Phase progress, as in the demo.
    const wr = win.getBoundingClientRect();
    const s0 = H * (narrow ? 0.8 : 0.95);
    const s1 = Math.min(s0 - 40, H * 0.5 - wr.height * 0.5);
    const t1 = clamp((s0 - wr.top) / (s0 - s1));
    const pr = pin.getBoundingClientRect();
    const t2 = clamp((H * 0.85 - pr.top) / (H * 0.85));
    const orbit = clamp(-pr.top / Math.max(1, pr.height - H));
    const leave = clamp((pr.bottom - H * 0.2) / (H * 0.5));
    const t4 = clamp((H - wlSec.getBoundingClientRect().top) / (H * 0.6));

    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, cssW, cssH);
    let phase: string;
    let shown: Box;
    let frameIdx = -1;
    floating = false;
    if (t4 > 0 && leave <= 0) {
      phase = "waitlist";
      const k = mix(0.72, 1, ease(t4));
      shown = { x: wlB.x, y: wlB.y + bob * wlB.tile * 0.02, tile: wlB.tile * k };
      put(front, shown.x, shown.y, shown.tile, STILL_FILL, ease(t4));
      floating = true;
    } else if (t2 > 0) {
      const e = ease(t2);
      phase = e >= 1 ? "receipts" : "to-receipts";
      shown = { x: mix(dockB.x, rcB.x, e), y: mix(dockB.y, rcB.y, e), tile: Math.pow(dockB.tile, 1 - e) * Math.pow(rcB.tile, e) };
      // Rocks left and right with the orbit (the demo's rotY), shadow-free on black.
      frameIdx = Math.round(clamp(FACE + Math.sin(orbit * Math.PI * 2) * 0.28 * (count - 1) * e, 0, count - 1));
      put(front, shown.x, shown.y, shown.tile, STILL_FILL, leave * (1 - e));
      putFrame(nearest(frameIdx), shown.x, shown.y, shown.tile, leave * e, 1);
    } else if (t1 > 0) {
      const e = ease(t1);
      phase = t1 >= 1 ? "dock" : "to-dock";
      // On a phone the hero is long gone by now: start from just under the nav
      // instead of arcing up out of sight.
      const startY = narrow ? Math.max(heroB.y, NAV + heroB.tile * 0.6) : heroB.y;
      const arc = narrow ? 0 : Math.sin(e * Math.PI) * -0.08 * H;
      shown = {
        x: mix(heroB.x, dockB.x, e),
        y: Math.max(mix(startY, dockB.y, e) + arc, narrow ? NAV + 8 : -Infinity),
        tile: Math.pow(heroB.tile, 1 - e) * Math.pow(dockB.tile, e),
      };
      // Turn to face the camera on the way in, then settle into the clean front
      // still. The floor shadow fades out as it lifts off.
      frameIdx = Math.round(mix(heroIdx, FACE, Math.min(1, e * 1.25)));
      const settle = clamp((e - 0.8) / 0.2);
      putFrame(nearest(frameIdx), shown.x, shown.y, shown.tile, 1 - settle, clamp(e / 0.25));
      put(front, shown.x, shown.y, shown.tile, STILL_FILL, settle);
    } else {
      phase = "hero";
      shown = { x: heroB.x, y: heroB.y + bob * heroB.tile * 0.02, tile: heroB.tile };
      frameIdx = heroIdx;
      putFrame(nearest(heroIdx), shown.x, shown.y, shown.tile, 1, 0);
      floating = shown.y + shown.tile > 0;
    }
    ctx.globalAlpha = 1;
    chip.classList.toggle("docked", t1 >= 1 && t2 < 0.15);
    const d = canvas.dataset;
    d["phase"] = phase;
    d["frame"] = String(frameIdx);
    d["x"] = shown.x.toFixed(1);
    d["y"] = shown.y.toFixed(1);
    d["tile"] = shown.tile.toFixed(1);
    // The idle float keeps drawing only while a floating icon is on screen.
    if (floating && !document.hidden) schedule();
  };

  function schedule(): void {
    if (queued) return;
    queued = true;
    requestAnimationFrame(draw);
  }

  // Frame 0 and the stills load first; the turn's other 71 frames wait until
  // the person scrolls or the hero leaves view, so a phone that never scrolls
  // never downloads them.
  let restStarted = false;
  const loadRest = (): void => {
    if (restStarted) return;
    restStarted = true;
    let next = 1;
    const worker = async (): Promise<void> => {
      while (next < count) {
        const i = next++;
        frames[i] = await loadImage(`/hero/f-${pad(i)}.webp`);
        schedule();
      }
    };
    void Promise.all([worker(), worker(), worker(), worker()]);
  };

  void (async () => {
    const [f0, fr] = await Promise.all([loadImage(`/hero/f-${pad(0)}.webp`), loadImage("/img/icon-front.webp")]);
    // Every image the journey needs up front must be there, or the stills stay.
    if (!f0 || !fr) return;
    frames[0] = f0;
    front = fr;
    size();
    started = true;
    document.documentElement.classList.add("fly-on");
    schedule();
    if (scrollY > 0) loadRest();
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => !e.isIntersecting)) {
        io.disconnect();
        loadRest();
      }
    });
    io.observe(hero);
  })();

  addEventListener(
    "scroll",
    () => {
      if (!started) return;
      loadRest();
      schedule();
    },
    { passive: true },
  );
  addEventListener("resize", () => {
    if (!started) return;
    size();
    schedule();
  });
  document.addEventListener("visibilitychange", () => started && schedule());
}

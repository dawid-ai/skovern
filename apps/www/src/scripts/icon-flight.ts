// The hero icon's journey down the home page (round-3 demo, loop 053), drawn
// from the Cycles renders on one fixed canvas over the page:
//   1. hero: the 72-frame turntable scrubs with scroll, so the icon spins;
//   2. "It stays home": it flies into the app window's brain chip and docks;
//   3. receipts: it moves to the centre of the orbiting receipt cards;
//   4. waitlist: it settles above the form.
// The anchors (#a-hero, .socket, #a-rc, #a-wl) keep still images; they show
// whenever this doesn't run (reduced motion, no canvas, no JavaScript) and hide
// while it does (html.fly-on). Tests read the canvas's data-* attributes.

const FRAME_FILL = 0.45; // the tile spans ~45% of a turntable frame's width
const STILL_FILL = 0.88; // ... and ~88% of a front still's width

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

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

export function startIconFlight(): void {
  const canvas = document.querySelector<HTMLCanvasElement>("#icon-fly");
  const hero = document.querySelector<HTMLElement>("#a-hero");
  const socket = document.querySelector<HTMLElement>("#f-chip .socket");
  const chip = document.querySelector<HTMLElement>("#f-chip");
  const win = document.querySelector<HTMLElement>("#f-win");
  const rc = document.querySelector<HTMLElement>("#a-rc");
  const pin = document.querySelector<HTMLElement>("#rc-pin");
  const wl = document.querySelector<HTMLElement>("#a-wl");
  const wlSec = document.querySelector<HTMLElement>("#waitlist");
  const count = Number(hero?.dataset["frames"] ?? 0);
  if (!canvas || !hero || !socket || !chip || !win || !rc || !pin || !wl || !wlSec || count < 2) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const frames: (HTMLImageElement | null)[] = new Array<HTMLImageElement | null>(count).fill(null);
  let front: HTMLImageElement | null = null;
  let frontDark: HTMLImageElement | null = null;
  // The frame that faces the camera most squarely: the docked pose blends into it.
  const FACE = Math.round((count - 1) * 0.46);
  let queued = false;
  let started = false;

  const size = (): void => {
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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

  const draw = (): void => {
    queued = false;
    const H = innerHeight;
    const narrow = innerWidth < 760;
    const heroB = box(hero, FRAME_FILL);
    const dockB = box(socket, STILL_FILL, 1.08);
    const rcB = box(rc, STILL_FILL);
    const wlB = box(wl, STILL_FILL);
    // Hero spin: the turn completes as the hero icon reaches the top of the screen.
    const heroRect = hero.getBoundingClientRect();
    const spin = clamp(scrollY / Math.max(1, heroRect.top + scrollY + heroRect.height * 0.45));
    const heroIdx = Math.round(spin * (count - 1));
    heroB.y += heroRect.height * 0.06 * spin; // drifts a little slower than the page
    // Phase progress, as in the demo.
    const wr = win.getBoundingClientRect();
    const s0 = H * (narrow ? 0.8 : 0.95);
    const s1 = Math.min(s0 - 40, H * 0.5 - wr.height * 0.5);
    const t1 = clamp((s0 - wr.top) / (s0 - s1));
    const pr = pin.getBoundingClientRect();
    const t2 = clamp((H * 0.85 - pr.top) / (H * 0.85));
    const leave = clamp((pr.bottom - H * 0.2) / (H * 0.5));
    const t4 = clamp((H - wlSec.getBoundingClientRect().top) / (H * 0.6));

    ctx.clearRect(0, 0, innerWidth, innerHeight);
    let phase: string;
    let shown: Box;
    let frameIdx = -1;
    if (t4 > 0 && leave <= 0) {
      phase = "waitlist";
      const k = mix(0.72, 1, ease(t4));
      shown = { x: wlB.x, y: wlB.y, tile: wlB.tile * k };
      put(front, shown.x, shown.y, shown.tile, STILL_FILL, ease(t4));
    } else if (t2 > 0) {
      const e = ease(t2);
      phase = e >= 1 ? "receipts" : "to-receipts";
      shown = { x: mix(dockB.x, rcB.x, e), y: mix(dockB.y, rcB.y, e), tile: Math.pow(dockB.tile, 1 - e) * Math.pow(rcB.tile, e) };
      put(front, shown.x, shown.y, shown.tile, STILL_FILL, leave * (1 - e));
      put(frontDark, shown.x, shown.y, shown.tile, STILL_FILL, leave * e);
    } else if (t1 > 0) {
      const e = ease(t1);
      phase = t1 >= 1 ? "dock" : "to-dock";
      const arc = Math.sin(e * Math.PI) * -0.08 * H;
      shown = {
        x: mix(heroB.x, dockB.x, e),
        y: mix(heroB.y, dockB.y, e) + arc,
        tile: Math.pow(heroB.tile, 1 - e) * Math.pow(dockB.tile, e),
      };
      // Turn to face the camera on the way in, then settle into the clean front still.
      frameIdx = Math.round(mix(heroIdx, FACE, Math.min(1, e * 1.25)));
      const settle = clamp((e - 0.8) / 0.2);
      put(nearest(frameIdx), shown.x, shown.y, shown.tile, FRAME_FILL, 1 - settle);
      put(front, shown.x, shown.y, shown.tile, STILL_FILL, settle);
    } else {
      phase = "hero";
      shown = heroB;
      frameIdx = heroIdx;
      put(nearest(heroIdx), heroB.x, heroB.y, heroB.tile, FRAME_FILL, 1);
    }
    ctx.globalAlpha = 1;
    chip.classList.toggle("docked", t1 >= 1 && t2 < 0.15);
    const d = canvas.dataset;
    d["phase"] = phase;
    d["frame"] = String(frameIdx);
    d["x"] = shown.x.toFixed(1);
    d["y"] = shown.y.toFixed(1);
    d["tile"] = shown.tile.toFixed(1);
  };

  const schedule = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(draw);
  };

  // Frame 0 and the stills first (the page shows the still hero until then),
  // then the rest of the turntable after the page has loaded, a few at a time.
  void (async () => {
    const [f0, fr, frd] = await Promise.all([
      loadImage(`/hero/f-${pad(0)}.webp`),
      loadImage("/img/icon-front.webp"),
      loadImage("/img/icon-front-dark.webp"),
    ]);
    if (!f0) return;
    frames[0] = f0;
    front = fr;
    frontDark = frd;
    size();
    started = true;
    document.documentElement.classList.add("fly-on");
    schedule();
    const rest = async (): Promise<void> => {
      let next = 1;
      const worker = async (): Promise<void> => {
        while (next < count) {
          const i = next++;
          frames[i] = await loadImage(`/hero/f-${pad(i)}.webp`);
          schedule();
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
    };
    if (document.readyState === "complete") void rest();
    else addEventListener("load", () => void rest(), { once: true });
  })();

  addEventListener("scroll", () => started && schedule(), { passive: true });
  addEventListener("resize", () => {
    if (!started) return;
    size();
    schedule();
  });
}

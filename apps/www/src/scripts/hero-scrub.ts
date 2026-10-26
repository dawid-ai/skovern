// Apple-style scroll scrub for the hero icon: a canvas draws one pre-rendered
// Cycles frame per scroll position. The still image stays up until frame 0 is
// ready, and stays for good when motion is reduced or the canvas can't draw.
// Frames load after first paint, nearest-to-start first, so the hero is never
// blocked on the sequence.

const pad = (n: number): string => String(n).padStart(3, "0");

export function startHeroScrub(): void {
  const anchor = document.querySelector<HTMLElement>("#a-hero");
  const canvas = anchor?.querySelector("canvas");
  const hero = anchor?.closest<HTMLElement>(".hero");
  const count = Number(anchor?.dataset["frames"] ?? 0);
  if (!anchor || !canvas || !hero || count < 2) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  // why: the frames are lit for the light stage; on a dark stage their glass edges
  // pick up the wrong surroundings, so dark mode keeps the dark-safe still.
  if (anchor.dataset["darkScrub"] !== "1" && matchMedia("(prefers-color-scheme: dark)").matches) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const frames: (HTMLImageElement | null)[] = new Array<HTMLImageElement | null>(count).fill(null);
  let shown = -1;
  let queued = false;

  const size = (): void => {
    measure();
    const r = anchor.getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    shown = -1;
  };

  // The turn completes as the icon reaches the top of the screen.
  let span = 1;
  const measure = (): void => {
    const r = anchor.getBoundingClientRect();
    span = Math.max(1, r.top + scrollY + r.height * 0.45);
  };
  const progress = (): number => Math.min(1, Math.max(0, scrollY / span));

  /** The loaded frame nearest to `want`, so a fast scroll never shows a blank. */
  const nearest = (want: number): number => {
    for (let d = 0; d < count; d += 1) {
      if (frames[want - d]) return want - d;
      if (frames[want + d]) return want + d;
    }
    return -1;
  };

  const draw = (): void => {
    queued = false;
    const p = progress();
    const idx = nearest(Math.round(p * (count - 1)));
    // The icon drifts up a little slower than the page, like a product on a turntable.
    canvas.style.transform = `translateY(${(p * 6).toFixed(2)}%)`;
    if (idx < 0 || idx === shown) return;
    const img = frames[idx];
    if (!img) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    shown = idx;
  };
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(draw);
  };

  const load = (i: number): Promise<void> =>
    new Promise((resolve) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => {
        frames[i] = img;
        if (i === 0) {
          size();
          anchor.classList.add("scrub-on");
        }
        schedule();
        resolve();
      };
      img.onerror = () => resolve();
      img.src = `/hero/f-${pad(i)}.webp`;
    });

  // Frame 0 first, then the rest in order, a few at a time.
  void (async () => {
    await load(0);
    if (!frames[0]) return;
    let next = 1;
    const worker = async (): Promise<void> => {
      while (next < count) await load(next++);
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  })();

  addEventListener("scroll", schedule, { passive: true });
  addEventListener("resize", () => {
    size();
    schedule();
  });
}

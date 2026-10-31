// Constants and small helpers for icon-flight.ts: the numbers measured off
// the renders, the idle sway's timing, and the guards that decide whether the
// flight runs at all. Nothing here touches the page at import time, so the
// unit tests (test/frame-count.test.ts) import it directly.

export const FRAME_FILL = 0.43; // the tile spans ~43% of a turntable frame's width
export const STILL_FILL = 0.88; // ... and ~88% of a front still's width
/** Where the tile sits inside a turntable frame, across all 72 (fractions of
 *  the frame): the floor shadow lies outside it, below. */
export const TILE_IN_FRAME = { left: 0.25, top: 0.21, right: 0.75, bottom: 0.715 };
/** The lowest ink in any frame (the floor shadow), per px of tile, below the
 *  tile's centre: 0.33 of a frame, plus the idle bob. */
export const INK_BELOW = 0.33 / FRAME_FILL + 0.03;
export const NAV = 48;
/** More frames than this is a mistake in the build, not a smoother turn. */
export const MAX_FRAMES = 240;
/** The idle sway: from the resting pose out through SWAY frames (about 11
 *  degrees of turn) and back, once every SWAY_S seconds. It runs only while
 *  the page is at rest; any scroll pauses it where it is, so the scrub never
 *  jumps. Those frames load up front, with frame 0. */
export const SWAY = 14;
export const SWAY_S = 9;
export const BOB_S = 5.5;
/** A scroll this recent (ms) means the page isn't at rest. */
export const REST_MS = 500;

export const clamp = (v: number, a = 0, b = 1): number => Math.min(b, Math.max(a, v));
export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
export const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const pad = (n: number): string => String(n).padStart(3, "0");

export interface Box {
  x: number;
  y: number;
  /** Width of the TILE (the glass square) at this anchor, in CSS px. */
  tile: number;
}

export function box(el: Element, fill: number, k = 1): Box {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, tile: r.width * fill * k };
}

/** Load and decode an image; null if it fails. */
export async function loadImage(src: string): Promise<HTMLImageElement | null> {
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
    return img;
  } catch {
    return null;
  }
}

/** How many turntable frames to use, from the hero's data-frames: 0 (no
 *  flight) for anything that isn't a number of at least 2, never more than
 *  MAX_FRAMES. */
export function frameCount(raw: string | undefined): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 2) return 0;
  return Math.min(MAX_FRAMES, n);
}

/** Frames the idle sway may step through: none when the reader asked to save
 *  data (it then sways with the bob only, on frame 0), so a phone on a data
 *  saver never downloads more than frame 0 before a scroll. */
export function swayFrames(count: number, saveData: boolean): number {
  return saveData ? 0 : Math.max(0, Math.min(SWAY, count - 1));
}

/** The browser's data-saver flag (Chromium's Network Information API; other
 *  engines don't expose one, and count as not saving). */
export function wantsSaveData(): boolean {
  const c = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return c?.saveData === true;
}

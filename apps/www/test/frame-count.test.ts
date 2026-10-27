import { describe, expect, it } from "vitest";
import { MAX_FRAMES, SWAY, frameCount, swayFrames } from "../src/scripts/icon-flight-parts";

// The guards that decide whether the hero icon flies, and over how many frames
// (ledger www-frame-count-cap, loop 054 checker note 4), and how far it sways.

describe("frameCount", () => {
  it("uses the hero's frame count as is", () => {
    expect(frameCount("72")).toBe(72);
  });

  it(`caps it at ${MAX_FRAMES}`, () => {
    expect(MAX_FRAMES).toBe(240);
    expect(frameCount("240")).toBe(240);
    expect(frameCount("241")).toBe(240);
    expect(frameCount("100000")).toBe(240);
  });

  it("means no flight for anything that isn't a number of at least 2", () => {
    for (const raw of [undefined, "", "abc", "NaN", "Infinity", "-5", "0", "1", "1.9"]) expect(frameCount(raw), String(raw)).toBe(0);
  });
});

describe("swayFrames", () => {
  it(`sways through ${SWAY} frames, or fewer if there aren't that many`, () => {
    expect(swayFrames(72, false)).toBe(SWAY);
    expect(swayFrames(5, false)).toBe(4);
  });

  it("sways through no frames when the reader saves data", () => {
    expect(swayFrames(72, true)).toBe(0);
  });
});

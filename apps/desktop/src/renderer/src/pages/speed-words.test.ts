import { describe, expect, it } from "vitest";
import { speedWords } from "./speed-words.js";

describe("speedWords (046)", () => {
  it("rounds mid speeds to the nearest 5 and keeps small ones exact", () => {
    expect(speedWords(40)).toBe("Writes about 30 words a second"); // 30 words
    expect(speedWords(4)).toBe("Writes about 3 words a second");
    expect(speedWords(1.4)).toBe("Writes about 1 word a second");
  });
  it("caps very fast models instead of showing a number no one could read (Dawid, 2026-10-07)", () => {
    expect(speedWords(66)).toBe("Writes about 50 words a second"); // 49.5 words → still a number
    expect(speedWords(67)).toBe("Writes faster than you can read"); // 50.25 words → over the cap
    expect(speedWords(2112)).toBe("Writes faster than you can read"); // the 0.5B on a 7900 XTX
  });
  it("turns 'about 10' exactly where core's slow line sits (verdict.ts QUICK_TOKPS = 9.5 / 0.75)", () => {
    expect(speedWords(9.5 / 0.75)).toBe("Writes about 10 words a second");
    expect(speedWords(9.49 / 0.75)).toBe("Writes about 9 words a second");
  });
  it("says so honestly when it's very slow", () => {
    expect(speedWords(0.8)).toBe("Writes less than a word a second");
  });
  it("shows nothing for no speed, never a made-up number", () => {
    for (const v of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(speedWords(v)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { speedWords } from "./speed-words.js";

describe("speedWords (046)", () => {
  it("rounds big speeds to the nearest 5 and keeps small ones exact", () => {
    expect(speedWords(71.5)).toBe("Writes about 55 words a second"); // 53.6 words → 55
    expect(speedWords(4)).toBe("Writes about 3 words a second");
    expect(speedWords(1.4)).toBe("Writes about 1 word a second");
  });
  it("says so honestly when it's very slow", () => {
    expect(speedWords(0.8)).toBe("Writes less than a word a second");
  });
  it("shows nothing for no speed, never a made-up number", () => {
    for (const v of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(speedWords(v)).toBeNull();
  });
});

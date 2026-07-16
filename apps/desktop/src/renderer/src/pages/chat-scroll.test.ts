import { describe, expect, it } from "vitest";
import { atBottom, nextOffset, prevOffset } from "./chat-scroll.js";

// Loop 034 — pure scroll math behind the Chat auto-follow + jump buttons. No DOM here; the
// component measures the live thread and feeds these the numbers.

describe("atBottom", () => {
  it("U7: true only when scrolled to (within a hair of) the bottom", () => {
    expect(atBottom(920, 80, 1000)).toBe(true); // 920+80 = 1000
    expect(atBottom(915, 80, 1000)).toBe(true); // within the 8px slack
    expect(atBottom(500, 80, 1000)).toBe(false); // scrolled up → auto-follow pauses
    expect(atBottom(0, 200, 200)).toBe(true); // short thread, nothing to scroll → at bottom
  });
});

describe("prev/next reply offsets", () => {
  const replies = [100, 400, 700]; // three assistant bubbles at these offsets

  it("U8: prev = nearest reply above; null at/above the first (button disabled)", () => {
    expect(prevOffset(replies, 750)).toBe(700);
    expect(prevOffset(replies, 500)).toBe(400);
    expect(prevOffset(replies, 100)).toBeNull(); // at the first reply → nowhere up
    expect(prevOffset(replies, 0)).toBeNull();
  });

  it("U8: next = nearest reply below; null at/below the last (button disabled)", () => {
    expect(nextOffset(replies, 50)).toBe(100);
    expect(nextOffset(replies, 400)).toBe(700);
    expect(nextOffset(replies, 700)).toBeNull(); // at the last reply → nowhere down
    expect(nextOffset(replies, 900)).toBeNull();
  });

  it("empty thread → both null (all jump buttons disabled)", () => {
    expect(prevOffset([], 0)).toBeNull();
    expect(nextOffset([], 0)).toBeNull();
  });
});

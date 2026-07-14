import { describe, expect, it } from "vitest";
import type { ReceiptView } from "./receipts.js";
import { computeActivity, dayKey, intensity } from "./receipt-calendar.js";

function done(ts: string): ReceiptView {
  return { ts, provider: "openrouter", model: "m", task: "t", bytesSent: 1, bytesReceived: 1, ok: true, phase: "done" };
}
function sent(ts: string): ReceiptView {
  return { ...done(ts), phase: "sent" };
}

describe("dayKey", () => {
  it("is the UTC date, stable regardless of the ts offset", () => {
    expect(dayKey("2026-07-14T23:30:00.000Z")).toBe("2026-07-14");
    // a +02:00 wall-clock time past midnight is still the same UTC instant/day
    expect(dayKey("2026-07-15T01:30:00+02:00")).toBe("2026-07-14");
  });
  it("returns null on an unparseable ts", () => {
    expect(dayKey("not-a-date")).toBeNull();
  });
});

describe("computeActivity", () => {
  it("counts only done receipts, bucketed by UTC day", () => {
    const map = computeActivity([done("2026-07-14T10:00:00Z"), done("2026-07-14T12:00:00Z"), done("2026-07-15T09:00:00Z"), sent("2026-07-14T11:00:00Z")]);
    expect(map).toEqual({ "2026-07-14": 2, "2026-07-15": 1 }); // the "sent" line is not counted
  });
  it("empty in → empty out, never throws", () => {
    expect(computeActivity([])).toEqual({});
  });
  it("skips an unparseable ts without throwing", () => {
    expect(computeActivity([done("garbage")])).toEqual({});
  });
});

describe("intensity", () => {
  it("is 0 for an empty day or no activity at all", () => {
    expect(intensity(0, 10)).toBe(0);
    expect(intensity(5, 0)).toBe(0);
  });
  it("scales 1..4 against the busiest day, peak → 4", () => {
    expect(intensity(10, 10)).toBe(4);
    expect(intensity(1, 10)).toBe(1);
    // a heavier day is never lighter than a lighter day
    expect(intensity(8, 10)).toBeGreaterThanOrEqual(intensity(3, 10));
  });
});

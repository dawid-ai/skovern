import { describe, expect, it } from "vitest";
import type { ReceiptView } from "./receipts.js";
import { computeActivity, dayKey, intensity } from "./receipt-calendar.js";

function done(ts: string): ReceiptView {
  return { ts, provider: "openrouter", model: "m", task: "t", bytesSent: 1, bytesReceived: 1, ok: true, phase: "done" };
}
function sent(ts: string): ReceiptView {
  return { ...done(ts), phase: "sent" };
}
// A routine background poll (the 5s unread-message / news check) — a done FetchReceipt
// tagged routine:true. Must NOT count toward the calendar.
function routine(ts: string): ReceiptView {
  return { ts, kind: "fetch", host: "app.test", task: "Deskhand: messages", bytesSent: 0, bytesReceived: 0, ok: true, phase: "done", routine: true };
}
// A LEGACY poll: written before the `routine` flag existed, so it lacks the flag — must
// still be excluded by its known task label (the real-log case that showed thousands).
function legacyPoll(ts: string, task: string): ReceiptView {
  return { ts, kind: "fetch", host: "127.0.0.1:8787", task, bytesSent: 0, bytesReceived: 1, ok: true, phase: "done" };
}
// A real (non-routine) egress fetch — a download / publish — that DOES count.
function realFetch(ts: string): ReceiptView {
  return { ts, kind: "fetch", host: "huggingface.co", task: "Downloading model", bytesSent: 0, bytesReceived: 1, ok: true, phase: "done" };
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
  it("excludes routine background polls but keeps real egress", () => {
    const map = computeActivity([
      routine("2026-07-14T10:00:00Z"), // 5s message poll — excluded
      routine("2026-07-14T10:00:05Z"), // excluded
      realFetch("2026-07-14T11:00:00Z"), // a real download — counted
      done("2026-07-14T12:00:00Z"), // a model call — counted
    ]);
    expect(map).toEqual({ "2026-07-14": 2 }); // only the 2 non-routine calls
  });
  it("a day of nothing but message polls is empty on the calendar", () => {
    expect(computeActivity([routine("2026-07-14T10:00:00Z"), routine("2026-07-14T10:00:05Z")])).toEqual({});
  });
  it("excludes LEGACY polls that predate the routine flag, by their task label", () => {
    const map = computeActivity([
      legacyPoll("2026-07-14T10:00:00Z", "Deskhand: messages"), // no routine flag → label-excluded
      legacyPoll("2026-07-14T10:00:05Z", "Deskhand: news"), // label-excluded
      legacyPoll("2026-07-14T10:00:10Z", "Deskhand: model list"), // catalog fetch → label-excluded
      legacyPoll("2026-07-14T11:00:00Z", "Deskhand: your message to Dawid"), // a REAL send → counted
      done("2026-07-14T12:00:00Z"), // a model call → counted
    ]);
    expect(map).toEqual({ "2026-07-14": 2 }); // only the real send + model call
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

import { describe, expect, it } from "vitest";
import type { ReceiptView } from "./receipts.js";
import { filterByRange, pageCount, paginate } from "./receipt-filter.js";

function at(day: string): ReceiptView {
  return { ts: `${day}T12:00:00Z`, provider: "openrouter", model: "m", task: day, bytesSent: 1, bytesReceived: 1, ok: true, phase: "done" };
}

describe("filterByRange", () => {
  const rows = [at("2026-07-10"), at("2026-07-12"), at("2026-07-14"), at("2026-07-16")];

  it("keeps only receipts within [from, to] inclusive", () => {
    expect(filterByRange(rows, { from: "2026-07-12", to: "2026-07-14" }).map((r) => r.task)).toEqual(["2026-07-12", "2026-07-14"]);
  });
  it("treats an absent bound as open-ended", () => {
    expect(filterByRange(rows, { from: "2026-07-14" }).map((r) => r.task)).toEqual(["2026-07-14", "2026-07-16"]);
    expect(filterByRange(rows, { to: "2026-07-12" }).map((r) => r.task)).toEqual(["2026-07-10", "2026-07-12"]);
  });
  it("an empty (from > to) range matches nothing", () => {
    expect(filterByRange(rows, { from: "2026-07-16", to: "2026-07-10" })).toEqual([]);
  });
  it("no bounds → everything", () => {
    expect(filterByRange(rows, {})).toHaveLength(4);
  });
  it("preserves identity so callers can Set-match the results", () => {
    const out = filterByRange(rows, { from: "2026-07-14" });
    expect(out[0]).toBe(rows[2]); // same object reference, not a clone
  });
});

describe("paginate / pageCount", () => {
  const items = Array.from({ length: 25 }, (_v, i) => i);

  it("slices into pages of N; first full, last is the remainder", () => {
    const pages = paginate(items, 10);
    expect(pages).toHaveLength(3);
    expect(pages[0]).toHaveLength(10);
    expect(pages[2]).toEqual([20, 21, 22, 23, 24]);
    expect(pageCount(25, 10)).toBe(3);
  });
  it("an out-of-range page index is simply absent (caller clamps)", () => {
    const pages = paginate(items, 10);
    expect(pages[5]).toBeUndefined();
  });
  it("empty list → no pages", () => {
    expect(paginate([], 10)).toEqual([]);
    expect(pageCount(0, 10)).toBe(0);
  });
  it("a non-positive size collapses to one page (no divide-by-zero/infinite loop)", () => {
    expect(paginate(items, 0)).toEqual([items]);
    expect(pageCount(25, 0)).toBe(1);
  });
});

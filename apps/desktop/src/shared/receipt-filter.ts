import type { DateRange, ReceiptView } from "./receipts.js";
import { dayKey } from "./receipt-calendar.js";

// Pure table helpers: filter a receipt list to a whole-day date range, and slice it
// into pages. No Electron, no fs — testable in isolation. The renderer applies these
// over the loaded window; the calendar (full history) is a separate path.

// Keep only receipts whose UTC day falls within [from, to] inclusive. An absent bound
// is open-ended; a range whose `from` is after `to` matches nothing (→ []). A receipt
// with an unparseable ts is dropped (it can't be placed on a day).
export function filterByRange(receipts: readonly ReceiptView[], range: DateRange): ReceiptView[] {
  const { from, to } = range;
  if (from !== undefined && to !== undefined && from > to) return [];
  return receipts.filter((r) => {
    const day = dayKey(r.ts);
    if (day === null) return false;
    if (from !== undefined && day < from) return false;
    if (to !== undefined && day > to) return false;
    return true;
  });
}

// Split a list into pages of `size`. Guards a non-positive size (→ one page with
// everything) so a bad prop can't divide-by-zero or loop forever.
export function paginate<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) return items.length > 0 ? [items.slice()] : [];
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += size) pages.push(items.slice(i, i + size));
  return pages;
}

// The page count for a list of `total` items at `size` per page (≥ 0).
export function pageCount(total: number, size: number): number {
  if (size <= 0) return total > 0 ? 1 : 0;
  return Math.ceil(total / size);
}

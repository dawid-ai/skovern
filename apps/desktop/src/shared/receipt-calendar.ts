import type { ActivityMap, ReceiptView } from "./receipts.js";

// Pure calendar helpers, shared by main (rebuilding the durable index from the log)
// and the renderer (rendering the GitHub-style day grid). No Electron, no fs — just
// data in, data out, so it's unit-testable on its own.

// The UTC day a receipt's timestamp falls on ("YYYY-MM-DD"), or null if the ts is
// unparseable. UTC (not local) so the same fixture yields the same day on any runner.
export function dayKey(ts: string): string | null {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// Tally receipts into a day→count map, counting only completed ("done") calls so a
// call isn't double-counted by its "sent" + "done" pair. Empty in → empty out, never
// throws. This doubles as the durable index's rebuild-from-log path in main.
export function computeActivity(receipts: readonly ReceiptView[]): ActivityMap {
  const map: ActivityMap = {};
  for (const r of receipts) {
    if (r.phase !== "done") continue;
    const key = dayKey(r.ts);
    if (key === null) continue;
    map[key] = (map[key] ?? 0) + 1;
  }
  return map;
}

// A day's shade, 0–4 (0 = empty, 4 = busiest), scaled against the busiest day shown so
// the darkest square is always the peak. `max <= 0` (no activity) → every day is 0.
export function intensity(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || max <= 0) return 0;
  const level = Math.ceil((count / max) * 4);
  return Math.min(4, Math.max(1, level)) as 1 | 2 | 3 | 4;
}

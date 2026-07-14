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

// Does a receipt count toward the activity calendar? Only a COMPLETED ("done") call
// (so a "sent"+"done" pair isn't double-counted) that ISN'T a routine background poll.
// The 5-second unread-message and news polls are `routine:true` (loop 023) — counting
// them would drown the heatmap in thousands of no-business-data checks a day, hiding the
// real egress. The table already de-emphasizes routine polls into a quiet summary; the
// calendar excludes them the same way. `routine` lives only on FetchReceipt, so `"routine"
// in r` narrows to it (a model receipt is never routine).
export function countsForActivity(r: ReceiptView): boolean {
  if (r.phase !== "done") return false;
  return !("routine" in r && r.routine === true);
}

// Tally receipts into a day→count map, counting only calls that pass countsForActivity.
// Empty in → empty out, never throws. This doubles as the durable index's rebuild path.
export function computeActivity(receipts: readonly ReceiptView[]): ActivityMap {
  const map: ActivityMap = {};
  for (const r of receipts) {
    if (!countsForActivity(r)) continue;
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

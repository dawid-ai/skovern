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

// The task labels the app tags `routine:true` for its background plumbing: the 5-second
// unread-message + news polls and the catalog fetch (all no-business-data housekeeping,
// see index.ts / catalog.ts). We match on the label AS WELL AS the flag because the log
// holds HISTORICAL receipts written before the `routine` flag existed — flag-only filtering
// would leave thousands of old polls counted. Keep this in sync with the `routine:true`
// call sites; the flag is authoritative for new receipts, the labels rescue legacy ones.
const ROUTINE_TASKS = new Set(["Skovern: messages", "Skovern: news", "Skovern: model list"]);

// Is this a routine background poll (excluded from the calendar)? True if flagged
// `routine`, OR — for pre-flag legacy receipts — if its task is a known routine label.
function isRoutinePoll(r: ReceiptView): boolean {
  if ("routine" in r && r.routine === true) return true;
  return ROUTINE_TASKS.has(r.task);
}

// Does a receipt count toward the activity calendar? Only a COMPLETED ("done") call
// (so a "sent"+"done" pair isn't double-counted) that ISN'T a routine background poll —
// counting the every-5s polls would drown the heatmap in housekeeping and hide the real
// egress (model calls, downloads, publishes, messages you actually send). The table
// de-emphasizes routine polls into a quiet summary; the calendar excludes them the same way.
export function countsForActivity(r: ReceiptView): boolean {
  return r.phase === "done" && !isRoutinePoll(r);
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

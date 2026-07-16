// Shapes crossing the renderer ↔ main IPC boundary for the "What leaves your
// machine" panel. Read-only metadata — host (never a full URL), a plain-English
// label, and byte counts. Never a key, header, or body.

import type { FetchReceipt, Receipt } from "@skovern/core";

export type { FetchReceipt, Receipt };

// One line the panel shows: a model (brain) call has no `kind`; a fetch call —
// plugin OR first-party Skovern cloud — is tagged kind:"fetch". The renderer
// tells them apart with `"kind" in r`.
export type ReceiptView = Receipt | FetchReceipt;

// day (YYYY-MM-DD, UTC) → number of `done` receipts that day. UTC (not local) so a
// seeded fixture yields the same calendar on any CI runner regardless of its timezone.
export type ActivityMap = Record<string, number>;

// What the calendar needs: the per-day counts (from the durable index) plus the day
// the grid ends on ("today" from main — a seam so the e2e grid is fixed on any runner).
export interface ActivitySummary {
  counts: ActivityMap;
  today: string; // YYYY-MM-DD
}

// A whole-day inclusive date range for the table filter. An absent bound is open-ended.
export interface DateRange {
  from?: string; // YYYY-MM-DD
  to?: string; // YYYY-MM-DD
}

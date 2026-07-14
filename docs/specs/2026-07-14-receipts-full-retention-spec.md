# Spec — Receipts full-retention timeline, filtering + CSV export (loop 027, rescoped)

**Status:** draft — awaiting Dawid's approval before BUILD.
**Supersedes:** the aggregate-index default in `docs/loops/027-receipts-timeline-and-export.md`.
**Decisions taken (2026-07-14):** Dawid chose **full-retention rewrite**, built **as one loop**
(split into 027a/027b at BUILD only if the 3-iteration budget strains), AND to **keep the durable
daily-activity index** (the calendar reads the index, not the archives — render cost stays decoupled
from history depth).

## Why this is a spec (big feature)

Full retention **reopens the `receipts-audit-retention` ledger item** and **changes loop 017's
rotation semantics** (delete-oldest → durable archive, never delete). That is a retention-model
change, so per the loop skill it gets a spec + approval before code.

## How the two decisions fit together

We keep BOTH the contract's durable **daily-activity index** AND full retention:

- **Durable index** (`receipts-activity.json` in userData, survives rotation) = the calendar's fast
  path. Bumped on each `done` append; O(days) read. This is what the calendar renders from.
- **Never-delete archives** = the durable truth. Date-range, pagination, and CSV read the real rows
  from here (the index has only counts, not rows).
- **Free reconciliation:** the same pure `computeActivity(receipts)` tally that the index unit tests
  serves as a **one-time rebuild** — if the index file is missing/corrupt, `readActivityIndex`
  rebuilds it by streaming all archives + live, persists it, and returns it. So an EXISTING install's
  pre-upgrade `receipts.jsonl` history appears in the calendar (not just receipts written after this
  loop), and a corrupt index self-heals rather than degrading to empty.

## Retention design (the core change)

Today (`receipts.ts`): live `receipts.jsonl`; at ~2 MB it renames to `.1`, **deleting** any prior
`.1`. On-disk stays ~2×cap; history older than ~1000 receipts is gone.

**New:** at the cap, rename the live file to a **unique, dated archive** and start a fresh live
file. **Archives are never deleted.**

- Live hot file: `receipts.jsonl` (all appends land here; stays small).
- Archive on rotation: `receipts.<ISO-basic-ts>.jsonl` (e.g. `receipts.20260714T131502Z.jsonl`).
  Unique name → the rename is atomic on both OSes (no pre-existing target to clear, unlike `.1`),
  mirroring the download `.part.<n>` uniqueness pattern. Never appended-to again, never deleted.
- Reading (calendar, date-range, pagination, export) streams **live + every archive**, oldest→newest.

**Disk:** receipts are metadata-only lines (~150–250 bytes). A busy florist at, say, 200
receipts/day ≈ 15 MB/year. Unbounded but tiny. `ponytail: no retention cap — add a "keep last N
years" sweep only if disk is ever noticed; CSV export + this log are the transparency promise, so
keeping full history is a feature, not debt.`

**Privacy note (surfaced for the reviewer):** full retention means the "what leaves your machine"
log is now the user's *complete* history, not a rolling window. That strengthens the transparency
promise; the only cost is (tiny) unbounded local disk. No new data is retained that wasn't already
written — same metadata-only lines, just not deleted. No secrets (source rows never hold keys/bodies).

## Typed contracts

`apps/desktop/src/shared/receipts.ts` (additions):

```ts
/** date (YYYY-MM-DD, local) → number of `done` receipts that day. */
export type ActivityMap = Record<string, number>;

/** A whole-day inclusive range; an absent bound is open-ended. */
export interface DateRange { from?: string; to?: string } // "YYYY-MM-DD"
```

Export view: CSV is serialized in **main** (has the raw rows); the renderer passes the selected
rows' identities and main re-derives from disk, OR the renderer passes the already-loaded rows to
`receipts:exportCsv`. **Chosen (lazy + safe):** renderer sends the selected `ReceiptView[]`; main
sanitizes + serializes + writes. The rows are metadata-only and already crossed IPC on read, so
round-tripping them adds no new disclosure, and main stays the only writer.

## New / changed units

1. **Retention archive.** Appending past the cap rotates the live file to a dated archive; a second
   rotation makes a *second* archive (first not overwritten); reading returns rows from **all**
   archives + live. A rotation never loses past rows.
1b. **Durable index survives rotation + rebuilds.** A `done` append bumps its day's bucket in
   `receipts-activity.json` (rides the single-writer queue; the bump is best-effort — its failure
   must NOT fail the receipt's egress append). The index file is separate → a rotation that archives
   the log does NOT touch it. Reading it back yields the right `date→count` map. Missing/corrupt →
   `readActivityIndex` rebuilds from all files (never throws; `{}` only if the rebuild itself can't
   read disk).
2. **Activity counts (`receipt-calendar.ts`, pure).** `computeActivity(receipts)` → `ActivityMap`
   (day→count of `done`), keyed by the **UTC** calendar day of `ts`; empty input → `{}`, never
   throws. Doubles as the index rebuild path. Plus `intensity(count, max)` → a 0–4 bucket for the
   shade. **UTC, not local** (deliberate): it makes the heatmap + date-filter buckets deterministic
   on any runner/timezone with no `TZ` seam. Cost: activity in the hours around local midnight lands
   on the UTC day. Minor for a heatmap; `ponytail:` switch to local-day keys + a pinned `TZ` in the
   test configs only if a florist reports the midnight boundary bucketing wrong.
3. **CSV serialization (`csv.ts`, main, security-critical, negative).** Every captured field
   (ts, kind, provider/model, host, task, direction, routine, local, bytesSent, bytesReceived,
   tokensIn, tokensOut, ok, phase) with correct headers + RFC-4180 quoting (commas/quotes/newlines).
   **Formula-injection neutralized:** a cell starting with `= + - @` or a leading tab/CR/`\r` is
   prefixed with `'` so a spreadsheet can't execute it. Asserts `task=` `=cmd|'/c calc'!A1` exports
   inert.
4. **Date-range filter (`receipt-filter.ts`, pure).** `[from,to]` inclusive whole-day; empty range
   → `[]`; absent bound open-ended.
5. **Pagination (`receipt-filter.ts`, pure).** Slice into pages of N; page count, first/last,
   out-of-range index all correct.

## IPC (main)

- `receipts:activity` → `ActivityMap` — returns `readActivityIndex()` (fast: reads the durable
  index; rebuilds from all files once if missing/corrupt). O(days) on the hot path.
- `receipts:exportCsv(rows: ReceiptView[])` → writes via `dialog.showSaveDialog`; **CI seam**
  `DESKHAND_EXPORT_PATH` (gated `!app.isPackaged`) writes to a fixed temp path, bypassing the
  dialog, so the e2e asserts file CONTENT deterministically. Empty `rows` → no-op (button disabled
  renderer-side too).
- `receipts:list(range?)` — **no range** → the recent window (`readReceipts`: most-recent archive +
  live, newest-500; the fast mount load). **A range** → `readReceiptsInRange`: streams EVERY archive
  + live, filtered to the dates, newest-first, bounded to 2000 (logs if it truncates). This is what
  makes a **calendar click reach rows that aged out of the recent window** — without it the calendar
  would advertise history the table couldn't show.

**Reader ceiling (`receipts-reader-line-bytes` ledger, pulled in):** widening the read to all
archives touches that item. We (a) enforce a **per-line byte cap** while streaming — a manual
chunked reader DROPS a line past 64 KB without ever buffering it whole, closing the ledger item —
and (b) bound each read: the no-range table load holds the newest-500 ring, a date-range read holds
the newest-2000 in range, and the **calendar tally streams without holding rows** (O(days) memory).
`ponytail: a date-range over deep history reads all files each call — fine at florist volume; add a
day-paged archive index only if someone genuinely ranges over >2000 receipts.`

## Determinism seam

- **"today" / calendar window** → `DESKHAND_NOW` (ISO), gated `!app.isPackaged`, read where the
  grid's date window is computed, so the calendar is identical on any runner/day.
- Receipts + archives written to the e2e temp `userData` at fixed dates.
- CSV path via `DESKHAND_EXPORT_PATH`.

## App e2e (`apps/desktop/e2e/receipts-timeline.spec.ts`)

Seeded receipts at KNOWN dates + pinned `DESKHAND_NOW`:
1. Calendar renders history — a busy day's square is darker than a light day's; an empty day empty;
   hover/click surfaces the count.
2. Date-range narrows the table; a zero-result range shows the empty state, calendar still renders.
3. Pagination — >1 page ⇒ controls appear + navigate; page 2 shows older rows than page 1.
4. Export selected → CSV — select ≥1 row, export, assert the written file's header + selected rows
   (all fields); nothing-selected ⇒ Export disabled, no file written.

**Degraded:** empty log → all-empty grid + existing empty state + Export disabled, no crash;
corrupt/oversized line → skipped, calendar degrades to empty rather than throwing.

## Boundary (delta from contract)

- **Add** `shared/receipt-calendar.ts` (counts+intensity), `shared/receipt-filter.ts`
  (range+paginate), `csv.ts` (main), `receipted-fetch.ts` (main — the fetch wrapper split out of
  `receipts.ts` as a distinct concern; behaviour-preserving, re-exported from `receipts.ts` so
  importers are unchanged). `receipts.ts` is still ~360 lines after the split — over the ~300 smell
  line, but it's one cohesive concern (the on-disk log + its derived activity index, sharing one
  single-writer queue), so further splitting would spread that queue across files for no real gain.
  NB the two pure modules live in `shared/` (not
  `renderer/pages/` as the contract wrote) because main's index-rebuild + ranged read import them too.
- **Change** `receipts.ts` (archive-not-delete rotation + all-files reader + ranged read + per-line
  cap + durable index), `index.ts` (`receipts:list(range?)`, `receipts:activity`,
  `receipts:exportCsv`, `DESKHAND_NOW`/`DESKHAND_EXPORT_PATH` seams), `preload/index.ts` +
  `shared/global.d.ts` (expose the IPCs to the renderer), `shared/receipts.ts` (`ActivityMap`,
  `ActivitySummary`, `DateRange`), `ReceiptsPage.tsx` (calendar + controls + selection + Export),
  `app.css`.
- **Kept from contract:** the durable daily-index (`receipts-activity.json`), now backed by
  full-retention archives + a rebuild-on-missing path.
- **`apps/site` untouched. No new dependency** (native `<input type="date">`, hand-rolled CSV).

## Ledger reconciliation at close

- `receipts-audit-retention` → **CLOSED** (full retention shipped; delete-on-rotation gone).
- `receipts-reader-line-bytes` → **CLOSED** (per-line byte cap enforced in the reader).
- `panel-orphaned-sent` → CSV export carries `phase` incl. `sent`-only rows (partial; table still
  filters `done` — note if not surfaced as a row).

## Out of scope (unchanged)

Charts beyond the day-grid; PDF/xlsx; a date-picker library; editing/deleting receipts; server-side
/ cross-device receipts; a retention cap (deferred with a `ponytail:` marker + trigger).

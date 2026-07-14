import { app } from "electron";
import { createReadStream, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import type { FetchReceipt, FetchSink, Receipt, ReceiptSink } from "@deskhand/core";
import type { ActivityMap, ReceiptView } from "../shared/receipts.js";
import { computeActivity, dayKey } from "../shared/receipt-calendar.js";

// The egress-fetch wrapper lives in its own module now (concern split); re-exported here
// so existing `from "./receipts.js"` importers are unchanged.
export { receiptedFetch } from "./receipted-fetch.js";

// The "what left your machine" log, on disk. One JSON object per line so the panel
// can tail it. Every append (model + fetch) runs through one single-writer queue
// (see `serialize` below) so two concurrent writers can't interleave a line, and is
// awaited-and-unswallowed at the call site: if it throws (disk full, permissions),
// the router's/fetch's call fails — fail-closed, no silent egress. Receipts are
// metadata only; the caller never puts a key or body here.

export function receiptsFile(): string {
  return path.join(app.getPath("userData"), "receipts.jsonl");
}

// The live log rotates at ~2 MB. Loop 027: full retention — on rotation the live file
// is renamed to a UNIQUE dated archive and KEPT forever (never deleted), so the "what
// leaves your machine" log is the user's complete history, not a rolling window.
// Receipts are tiny metadata lines (~250 B), so this is a few MB/year.
// ponytail: no retention cap — add a "keep last N years" sweep only if disk is ever
// noticed; keeping full history IS the transparency promise, and CSV export can offload.
const MAX_BYTES = 2 * 1024 * 1024;

// A unique archive path: `receipts.<basic-ISO>.jsonl` (e.g. receipts.20260714T131502Z
// .jsonl). Unique → the rename has no pre-existing target, so it's atomic on BOTH
// Windows and POSIX (unlike the old `.1`, which needed an unlink-first on Windows).
// The name sorts chronologically. A same-second collision (rotation twice in one
// second — impossible in practice: a fresh live file is far from the cap) gets a
// numeric suffix so we still never clobber history.
function archivePath(): string {
  const dir = app.getPath("userData");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  let name = `receipts.${stamp}.jsonl`;
  for (let n = 1; existsSync(path.join(dir, name)); n++) name = `receipts.${stamp}.${n}.jsonl`;
  return path.join(dir, name);
}

// Bound the LIVE file on disk: when it reaches the cap, rename it to a dated archive
// and start a fresh live file. Full retention → the archive is never deleted. Called
// BEFORE every append inside the write lock, and NOT wrapped in try/catch: if it throws
// the append fails closed — no byte leaves the machine unrecorded.
function rotateIfNeeded(): void {
  const file = receiptsFile();
  if (!existsSync(file)) return; // nothing written yet
  if (statSync(file).size < MAX_BYTES) return;
  renameSync(file, archivePath()); // unique target → atomic on win+posix, history preserved
}

// Every receipt log file, OLDEST→NEWEST: a legacy pre-027 `.1` (if an install had one)
// first, then the dated archives in chronological (name) order, then the live file last.
// Used by the calendar's index rebuild (needs ALL history) and, for the panel, only the
// tail two (see readReceipts).
function allLogFiles(): string[] {
  const dir = app.getPath("userData");
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    entries = [];
  }
  const legacy = entries.filter((f) => f === "receipts.jsonl.1"); // pre-027 rolled log, if any
  const archives = entries
    .filter((f) => f.startsWith("receipts.") && f.endsWith(".jsonl") && f !== "receipts.jsonl")
    .sort(); // basic-ISO names sort chronologically, oldest first
  return [...legacy, ...archives, "receipts.jsonl"].map((f) => path.join(dir, f));
}

// Single-writer queue: model AND fetch receipts share ONE serialized append chain, so
// two writers can never interleave a line in receipts.jsonl regardless of OS append
// atomicity. Main is the only process that writes this file (023's single-instance lock
// keeps a rival process from ever racing it), so an in-process queue is enough — no
// cross-process file lock. A failed append rejects its OWN caller (fail-closed: the
// router / receiptedFetch never lets a byte leave unrecorded), but is swallowed off the
// chain so one failure can't wedge the queue for the next writer.
// ponytail: in-process queue; add a file lock only if a multi-writer process ever appears.
let writeTail: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const run = writeTail.then(work, work); // run regardless of the prior append's outcome
  writeTail = run.catch(() => {}); // the chain never rejects; the caller (below) still sees its own failure
  return run;
}

// The one place a receipt line reaches disk. Rotate INSIDE the lock so a rename can't
// race a write, append, then fsync so a pulled plug can't lose the proof a byte left
// (both sinks are durable now — the model path no longer trails the fetch path).
async function appendLine(line: string): Promise<void> {
  rotateIfNeeded();
  const fh = await open(receiptsFile(), "a");
  try {
    await fh.write(line);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

export function fileReceiptSink(): ReceiptSink {
  return {
    // Returns a Promise (ReceiptSink.append is `void | Promise<void>`); the router
    // already awaits it, so the sent-before-egress ordering is unchanged.
    append: (receipt: Receipt): Promise<void> => appendAndIndex(receipt),
  };
}

// A plugin `fetch` (and every first-party cloud call) is egress too → same log, same
// durable single-writer path: the broker records the "sent" line before any byte leaves.
export function fileFetchSink(): FetchSink {
  return {
    append: (receipt: FetchReceipt): Promise<void> => appendAndIndex(receipt),
  };
}

// Append a receipt line (fail-closed egress record) and, for a COMPLETED call, bump the
// durable daily-activity index afterwards. The caller awaits only the line write; the
// index bump is best-effort and its failure swallowed — a UX cache must never deny a
// receipt its egress record. The bump runs after the line is durable so an index
// rebuild (which reads the log) stays consistent.
function appendAndIndex(receipt: ReceiptView): Promise<void> {
  const written = serialize(() => appendLine(JSON.stringify(receipt) + "\n"));
  if (receipt.phase === "done") void written.then(() => bumpActivity(receipt.ts)).catch(() => {});
  return written;
}

// How many receipts the panel ever loads at once — a bounded window, newest-first.
const MAX_RECEIPTS = 500;

// A hard per-line ceiling for the reader. A receipt line is ~250 B; anything past this
// is corrupt or hostile, so the streaming reader DROPS it without ever buffering the
// whole line in memory (closes the `receipts-reader-line-bytes` ledger item now that
// the reader can span archived history). 64 KB leaves generous headroom over a real line.
const MAX_LINE_BYTES = 64 * 1024;

// Turn one raw log line into a view, or null if it's not a well-formed receipt.
// A crash mid-append (or the known unlocked-append race) can leave a half-written
// line; we skip it instead of throwing so the panel never breaks on a bad line.
function parseLine(line: string): ReceiptView | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object") return null;
  const r = obj as Record<string, unknown>;
  if (typeof r["ts"] !== "string") return null;
  // A fetch receipt (plugin OR first-party) is tagged with kind:"fetch".
  if (r["kind"] === "fetch") {
    return typeof r["host"] === "string" && typeof r["task"] === "string" ? (obj as FetchReceipt) : null;
  }
  // Absence of `kind` means a model receipt (loop 011 shape).
  if (typeof r["provider"] === "string" && typeof r["model"] === "string") return obj as Receipt;
  return null;
}

// Stream one log file, invoking `onLine` per newline-terminated line. Reads in chunks
// and splits manually (not `readline`) so an over-long line can be DROPPED without ever
// holding it whole in memory: once the pending buffer passes MAX_LINE_BYTES with no
// newline, we discard it and resync at the next newline. Missing file → no-op.
async function streamLines(file: string, onLine: (line: string) => void): Promise<void> {
  if (!existsSync(file)) return;
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 64 * 1024 });
  let buf = "";
  let dropping = false; // discarding an over-cap line until its terminating newline
  try {
    for await (const chunk of stream) {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (dropping) {
          dropping = false; // this segment was the tail of a dropped over-cap line
          continue;
        }
        onLine(line);
      }
      if (buf.length > MAX_LINE_BYTES) {
        buf = ""; // over-cap partial line: drop it, keep memory bounded, resync at next newline
        dropping = true;
      }
    }
  } finally {
    stream.destroy();
  }
  // A trailing line with no final newline (only if within the cap and not mid-drop).
  if (!dropping && buf.length > 0 && buf.length <= MAX_LINE_BYTES) onLine(buf);
}

// Stream one file's parseable receipts into the shared ring, keeping only the newest N.
async function streamInto(file: string, ring: ReceiptView[]): Promise<void> {
  await streamLines(file, (line) => {
    const view = parseLine(line);
    if (view === null) return;
    ring.push(view);
    if (ring.length > MAX_RECEIPTS) ring.shift(); // bound memory regardless of file size
  });
}

// Read the egress log for the panel: at most the last MAX_RECEIPTS entries, newest
// first, malformed/over-cap lines skipped, [] if nothing's written yet. The newest 500
// always live in the current file (2 MB ≈ thousands of receipts) except right after a
// rotation, so reading the most-recent archive + the live file covers the window while
// staying O(2 files) instead of scanning all of history. The calendar's full history
// comes from the durable index, not here. Read-only — the renderer can never write here.
export async function readReceipts(): Promise<ReceiptView[]> {
  const ring: ReceiptView[] = [];
  const files = allLogFiles();
  for (const file of files.slice(-2)) await streamInto(file, ring); // most-recent archive + live
  return ring.reverse(); // newest first
}

// ── Durable daily-activity index (the calendar's fast path) ─────────────────────────
// A tiny `receipts-activity.json` (day→count) that the calendar renders from, so its
// cost is O(days shown), not O(all history). It's a separate file → log rotation never
// touches it. Bumped on each `done` append; rebuilt from the full log if ever missing
// or corrupt (so an existing install's pre-027 history shows up, and corruption self-
// heals). The jsonl log is the source of truth; this is only a cache.

function activityFile(): string {
  return path.join(app.getPath("userData"), "receipts-activity.json");
}

function isActivityMap(o: unknown): o is ActivityMap {
  if (o === null || typeof o !== "object" || Array.isArray(o)) return false;
  return Object.values(o as Record<string, unknown>).every((v) => typeof v === "number" && Number.isFinite(v));
}

// The index as-persisted, or null if missing/corrupt (→ caller rebuilds). Never throws.
function readActivityFileStrict(): ActivityMap | null {
  let raw: string;
  try {
    raw = readFileSync(activityFile(), "utf8");
  } catch {
    return null; // missing
  }
  try {
    const obj: unknown = JSON.parse(raw);
    return isActivityMap(obj) ? obj : null; // corrupt/wrong shape
  } catch {
    return null;
  }
}

// Best-effort write of the index. Non-atomic on purpose (ponytail): it's a cache, and a
// crash mid-write yields a corrupt file the reader simply rebuilds — no temp+rename
// dance needed. A write failure is swallowed by the callers.
function writeActivity(map: ActivityMap): void {
  writeFileSync(activityFile(), JSON.stringify(map));
}

// Bump a completed call's day by one — only when the index file already exists and is
// valid. If it's missing/corrupt we SKIP (don't overwrite good history with a stub);
// the next `readActivityIndex` rebuilds authoritatively from the log, which counts every
// `done` line exactly once. Runs on the single-writer queue so concurrent bumps (and the
// rebuild) can't lose an update. A rebuild REPLACES the count (not adds), so a bump can
// never double-count a line a later rebuild also sees.
async function bumpActivity(ts: string): Promise<void> {
  const key = dayKey(ts);
  if (key === null) return;
  await serialize(async () => {
    const map = readActivityFileStrict();
    if (map === null) return; // defer to rebuild-on-read
    map[key] = (map[key] ?? 0) + 1;
    writeActivity(map);
  });
}

// Rebuild the index from the ENTIRE log (all archives + live). Only run when the index
// is absent/corrupt, so the O(all-rows) cost is rare. Streams, so memory stays bounded.
async function computeActivityFromFiles(): Promise<ActivityMap> {
  const all: ReceiptView[] = [];
  for (const file of allLogFiles()) {
    await streamLines(file, (line) => {
      const view = parseLine(line);
      if (view !== null && view.phase === "done") all.push(view);
    });
  }
  return computeActivity(all);
}

// The calendar's read: the durable index if present+valid (fast); otherwise rebuild it
// from the log once, persist it, and return that. Never throws — a rebuild that can't
// read disk falls back to an empty map. The rebuild runs on the write queue so it can't
// interleave with a concurrent bump.
export async function readActivityIndex(): Promise<ActivityMap> {
  const cached = readActivityFileStrict();
  if (cached !== null) return cached;
  try {
    return await serialize(async () => {
      const again = readActivityFileStrict(); // a concurrent write may have just created it
      if (again !== null) return again;
      const rebuilt = await computeActivityFromFiles();
      try {
        writeActivity(rebuilt);
      } catch {
        // best-effort cache; the map is still correct to return
      }
      return rebuilt;
    });
  } catch {
    return {};
  }
}

import { app } from "electron";
import { appendFileSync, createReadStream, existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import type { FetchReceipt, FetchSink, Receipt, ReceiptSink } from "@deskhand/core";
import type { ReceiptView } from "../shared/receipts.js";

// The "what left your machine" log, on disk. One JSON object per line so a future
// panel can tail it. Append is synchronous and unguarded on purpose: if it throws
// (disk full, permissions), the router's call fails — fail-closed, no silent
// egress. Receipts are metadata only; the router never puts a key or body here.

export function receiptsFile(): string {
  return path.join(app.getPath("userData"), "receipts.jsonl");
}

// The single rotated log. One `.1` is enough: ~2 MB holds thousands of receipts,
// far more than the panel's 500, so aging out the oldest costs no visible history.
const MAX_BYTES = 2 * 1024 * 1024; // ~2 MB before the current log rotates to .1

function rotatedFile(): string {
  return receiptsFile() + ".1";
}

// Bound the log on disk: when the current file reaches the cap, rename it to `.1`
// (replacing any prior `.1`) so on-disk usage stays ~2×cap. Renames are atomic and
// never truncate the live file mid-write. Called BEFORE every append, and NOT
// wrapped in a try/catch: if it throws, the append fails closed — same as an append
// failure today, so no byte leaves the machine unrecorded.
function rotateIfNeeded(): void {
  const file = receiptsFile();
  if (!existsSync(file)) return; // nothing written yet
  if (statSync(file).size < MAX_BYTES) return;
  const rotated = rotatedFile();
  // Windows renameSync throws if the target already exists (EEXIST/EPERM); POSIX
  // would overwrite. Clear any prior `.1` first so a single rotated file is kept
  // uniformly on both platforms.
  if (existsSync(rotated)) unlinkSync(rotated);
  renameSync(file, rotated);
}

export function fileReceiptSink(): ReceiptSink {
  return {
    append(receipt: Receipt): void {
      rotateIfNeeded();
      appendFileSync(receiptsFile(), JSON.stringify(receipt) + "\n");
    },
  };
}

// A plugin `fetch` is egress too → same log, but DURABLE before it resolves: the
// broker records the "sent" line before any byte leaves, so the receipt must survive
// a crash mid-fetch. appendFileSync buffers in the OS page cache; here we fsync so a
// pulled plug can't lose the one proof that something left the machine.
export function fileFetchSink(): FetchSink {
  return {
    async append(receipt: FetchReceipt): Promise<void> {
      rotateIfNeeded();
      const fh = await open(receiptsFile(), "a");
      try {
        await fh.write(JSON.stringify(receipt) + "\n");
        await fh.sync();
      } finally {
        await fh.close();
      }
    },
  };
}

// How many receipts the panel ever loads. The file grows forever (rotation is a
// deferred ledger item), so the reader is bounded: it streams line-by-line and
// keeps only the newest N in memory — a huge log never loads whole.
const MAX_RECEIPTS = 500;

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

// Stream one log file's lines into the shared ring, keeping only the newest N.
// Missing file → no-op (the `.1` may not exist, or the current log not yet written).
async function streamInto(file: string, ring: ReceiptView[]): Promise<void> {
  if (!existsSync(file)) return;
  const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const view = parseLine(line);
      if (view === null) continue;
      ring.push(view);
      // Keep memory bounded regardless of file size: hold only the newest N.
      if (ring.length > MAX_RECEIPTS) ring.shift();
    }
  } finally {
    rl.close();
  }
}

// Read the egress log for the panel: at most the last MAX_RECEIPTS entries,
// newest first, malformed lines skipped, [] if the file doesn't exist yet.
// Reads the rotated `.1` (older) THEN the current file (newer) into the SAME ring,
// so the newest-N window and the final reverse fall out naturally across a rotation.
// Read-only — the renderer can never write here.
export async function readReceipts(): Promise<ReceiptView[]> {
  const ring: ReceiptView[] = [];
  await streamInto(rotatedFile(), ring);
  await streamInto(receiptsFile(), ring);
  return ring.reverse(); // newest first
}

// Wrap `fetch` so every first-party cloud call is receipted like a plugin fetch:
// a `"sent"` line lands on disk BEFORE any byte leaves (fail-closed — if the sink
// throws we never fetch), then a `"done"` line with the outcome. Metadata only:
// host (never the full URL / query string), a caller-supplied label, and byte
// counts — never a key, header, or body. One wrapper is built per client with its
// own label ("Deskhand: news", etc.).
function encodedBytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host; // host only — the path/query (where secrets hide) is dropped
  } catch {
    return "unknown";
  }
}

function bodyBytes(init: Parameters<typeof fetch>[1]): number {
  const body = init?.body;
  // The cloud clients send JSON strings; measure those, ignore other body shapes.
  return typeof body === "string" ? encodedBytes(body) : 0;
}

// `routine:true` marks the app's own timer polls (news/messages/model list) so the
// panel groups them at the source, not by sniffing the label. Default false — a
// caller must opt a client in explicitly, so no meaningful egress is ever grouped.
// `direction` (in/out) is likewise stamped here at the call site, never inferred.
export function receiptedFetch(
  sink: FetchSink,
  label: string,
  opts?: { routine?: boolean; direction?: "in" | "out" },
): typeof fetch {
  const routine = opts?.routine === true;
  const direction = opts?.direction;
  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const base = {
      kind: "fetch" as const,
      host: hostOf(requestUrl(input)),
      task: label,
      bytesSent: bodyBytes(init),
      ...(routine ? { routine: true } : {}),
      ...(direction ? { direction } : {}),
    };
    // Fail-closed: the "sent" receipt must be durable before egress. Awaited and
    // NOT swallowed — if it throws, we never fetch, so no byte leaves unrecorded.
    await sink.append({ ...base, ts: new Date().toISOString(), bytesReceived: 0, ok: false, phase: "sent" });

    let res: Response;
    try {
      res = await fetch(input, init);
    } catch (err) {
      try {
        await sink.append({ ...base, ts: new Date().toISOString(), bytesReceived: 0, ok: false, phase: "done" });
      } catch {
        // egress already receipted by the "sent" line
      }
      throw err;
    }

    let bytesReceived = 0;
    try {
      // Clone so the caller still gets an unread body; only the count is kept.
      bytesReceived = (await res.clone().arrayBuffer()).byteLength;
    } catch {
      bytesReceived = 0;
    }
    try {
      await sink.append({ ...base, ts: new Date().toISOString(), bytesReceived, ok: res.ok, phase: "done" });
    } catch {
      // egress already receipted by the "sent" line
    }
    return res;
  };
  // why: our wrapper covers the (input, init) call shape the clients use; the
  // extra static members on `typeof fetch` (e.g. preconnect) are never called.
  return wrapped as typeof fetch;
}

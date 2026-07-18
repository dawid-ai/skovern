import { app } from "electron";
import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, readdir, rename, stat, statfs, unlink } from "node:fs/promises";
import { createHash, type Hash } from "node:crypto";
import path from "node:path";
import type { FetchSink, GgufSource } from "@skovern/core";

// Our own model downloader for the EMBEDDED runtime. The no-Ollama user has no Ollama
// pull server, so we fetch the GGUF ourselves — and do it the privacy-safe way:
//
//  1. A fail-closed "sent" egress receipt lands BEFORE any byte leaves (if the sink
//     throws, we never fetch — no byte leaves unrecorded).
//  2. The body STREAMS to disk chunk-by-chunk, hashing as it goes. We never buffer the
//     whole multi-GB body — which is exactly why we can't reuse `receiptedFetch` (it
//     does `res.clone().arrayBuffer()` to count bytes → would OOM main on a 2 GB file).
//  3. A sha256 GATE: a file whose bytes don't match the catalog's expected hash is
//     deleted and rejected BEFORE it can ever be loaded into the native runtime — so a
//     corrupted download or a substituted weight file never runs.
//
// A fresh no-Ollama user's FIRST act is a multi-GB pull (loop 029), so the pull also:
//  4. RESUMES across restarts — the partial writes to a stable `<model>.part`; a restart
//     re-hashes what's there and asks the server for only the missing tail (`Range`). The
//     sha256 gate still guards the reassembled file, so a bad resume can't survive.
//  5. PRE-CHECKS disk space — a pull that can't fit is refused up-front (before any byte
//     leaves) instead of dying half-way with a cryptic write error.
//
// The download URL may 302 to a CDN (Hugging Face does); we follow redirects (default
// fetch behavior) and rely on https-only + the sha256 gate for integrity, not on
// pinning the first host.

const SAFE_GGUF_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.gguf$/;
// A temp part file: `<model>.gguf.part` (current) or legacy `<model>.gguf.part.<n>`. A
// real model always ends `.gguf`, so this never matches a finished model (even one whose
// own name contains "part", e.g. `my.part.gguf`).
const PART_SUFFIX = /\.part(\.\d+)?$/;
// Headroom kept free on top of the model bytes so the pull never wedges the disk.
const DISK_MARGIN_BYTES = 64 * 1024 * 1024;

// The final URL (after redirects) must stay https so a 302 can't DOWNGRADE an https
// catalog link to plain http. Loopback http is allowed ONLY unpackaged (the dev/test
// fixture); a packaged app is https-only, like every other seam.
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
export function isSafeFinalUrl(u: string, allowLoopback: boolean): boolean {
  try {
    const url = new URL(u);
    if (url.protocol === "https:") return true;
    return allowLoopback && url.protocol === "http:" && LOOPBACK.has(url.hostname);
  } catch {
    return false;
  }
}

export function modelsDir(): string {
  return path.join(app.getPath("userData"), "models");
}

// The one place a catalog filename becomes a path. Re-check the charset here (the
// catalog validator already drops a bad name, but the path sink lives here) so a bad
// caller can never write outside the models dir.
export function modelPath(filename: string): string {
  if (filename.includes("..") || !SAFE_GGUF_FILENAME.test(filename)) {
    throw new Error("That model file name isn't allowed.");
  }
  return path.join(modelsDir(), filename);
}

/** Is this embedded model already on disk? (file exists — the sha256 was verified at
 *  download time, so presence means a good file). */
export function modelDownloaded(filename: string): boolean {
  try {
    return existsSync(modelPath(filename));
  } catch {
    return false; // an unsafe filename is "not downloaded", never a throw
  }
}

/** Free bytes on the volume that holds the models dir. Default prober (statfs); injected
 *  in tests. Returns Infinity if it can't measure, so a probe failure never blocks a pull. */
async function defaultFreeBytes(): Promise<number> {
  try {
    const st = await statfs(app.getPath("userData")); // always exists; models dir may not yet
    return st.bavail * st.bsize;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Refuse up-front if `needBytes` (+ headroom) won't fit — BEFORE any byte leaves, so a
 *  doomed multi-GB pull fails honestly instead of dying half-way. A probe that can't
 *  measure (returns Infinity) never blocks. Exported for a direct unit. */
export async function ensureDiskSpace(needBytes: number, probeFreeBytes: () => Promise<number> = defaultFreeBytes): Promise<void> {
  const free = await probeFreeBytes();
  if (free < needBytes + DISK_MARGIN_BYTES) {
    throw new Error("There isn't enough free space on this computer for this model. Free up some room and try again.");
  }
}

/** Every finished (`.gguf`) model on disk, with its byte size — for the "Your models" list.
 *  Ignores `.part` temps and non-gguf files. Best-effort: a missing models dir yields []. */
export async function listDownloadedModels(): Promise<{ filename: string; sizeBytes: number }[]> {
  let entries: string[];
  try {
    entries = await readdir(modelsDir());
  } catch {
    return [];
  }
  const out: { filename: string; sizeBytes: number }[] = [];
  for (const name of entries) {
    // SAFE_GGUF_FILENAME requires a `.gguf` suffix, so a `.gguf.part` temp is already excluded.
    if (!SAFE_GGUF_FILENAME.test(name) || PART_SUFFIX.test(name)) continue;
    try {
      const s = await stat(path.join(modelsDir(), name));
      if (s.isFile()) out.push({ filename: name, sizeBytes: s.size });
    } catch {
      // vanished between readdir and stat — skip it
    }
  }
  return out;
}

/** Delete a downloaded model file to reclaim disk. `modelPath` validates the name (safe charset,
 *  no `..`, confined to `modelsDir`) and THROWS on anything else BEFORE any unlink — so a
 *  traversal/absolute path can never remove a file outside the models dir. Returns whether a file
 *  was actually removed (false = already gone / locked). */
export async function deleteDownloadedModel(filename: string): Promise<boolean> {
  const p = modelPath(filename); // throws on a bad/traversing name before we touch the disk
  try {
    await unlink(p);
    return true;
  } catch {
    return false;
  }
}

/** Startup housekeeping: remove stale `*.part`/`*.part.<n>` temp files, EXCEPT the
 *  resumable `<f>.part` for a currently-known model `f` (those are picked up by resume).
 *  Reclaims disk from crashes and from the old unique-name scheme. Best-effort; returns
 *  how many it removed. */
export async function sweepOrphanParts(keepFilenames: string[]): Promise<number> {
  const keep = new Set(keepFilenames.map((f) => `${f}.part`));
  let entries: string[];
  try {
    entries = await readdir(modelsDir());
  } catch {
    return 0; // no models dir yet → nothing to sweep
  }
  let removed = 0;
  for (const name of entries) {
    if (!PART_SUFFIX.test(name) || keep.has(name)) continue;
    try {
      await unlink(path.join(modelsDir(), name));
      removed++;
    } catch {
      // another process/handle holds it — leave it, next sweep gets it
    }
  }
  return removed;
}

/** Re-hash an existing partial into `hash`, returning how many bytes it held — so a
 *  resumed download continues the SAME sha256 stream the gate will check at the end. */
function rehashExisting(part: string, hash: Hash): Promise<number> {
  return new Promise((resolve, reject) => {
    let n = 0;
    const rs = createReadStream(part);
    rs.on("data", (c: Buffer) => {
      hash.update(c);
      n += c.length;
    });
    rs.on("end", () => resolve(n));
    rs.on("error", reject);
  });
}

export interface DownloadProgress {
  completed: number;
  total: number;
  /** 0–100 for the progress bar. */
  percent: number;
}

// Same-model single-writer guard: main is the only writer, so an in-process Set is enough
// to stop two concurrent pulls of the same file from fighting over its `.part`.
// ponytail: in-process only — sound while main is the sole downloader.
const inFlight = new Set<string>();

/** Download + verify a GGUF, returning its on-disk path. Resumes from a `<model>.part`
 *  left by a prior run. Rejects (descriptively) on any failure or a hash mismatch,
 *  leaving the `.part` in place so a later call can resume it. */
export async function downloadModel(
  gguf: GgufSource,
  sink: FetchSink,
  onProgress?: (p: DownloadProgress) => void,
  fetchImpl: typeof fetch = fetch,
  probeFreeBytes: () => Promise<number> = defaultFreeBytes,
): Promise<string> {
  const dest = modelPath(gguf.filename); // throws on an unsafe name before anything else
  // Stable temp name (not a per-call unique one) so a restart can find + resume the
  // partial. The real `dest` is created ONLY after the sha256 passes, so a corrupt/
  // tampered download never exists under `dest` even if this is interrupted.
  const part = `${dest}.part`;

  if (inFlight.has(dest)) throw new Error("This model is already downloading.");
  inFlight.add(dest);
  try {
    // https-only: an untrusted catalog url can't be http/file/etc.
    let host: string;
    try {
      const u = new URL(gguf.url);
      if (u.protocol !== "https:") throw new Error("not https");
      host = u.host;
    } catch {
      throw new Error("This model's download link isn't a secure https link.");
    }

    // How much is already on disk (cheap stat) → how much we still need. Refuse for disk
    // BEFORE the "sent" receipt/egress, so a doomed pull leaves no trace and no byte moves.
    const already = existsSync(part) ? statSync(part).size : 0;
    await ensureDiskSpace(Math.max(0, gguf.sizeBytes - already), probeFreeBytes);

    // Fail-closed egress receipt BEFORE any byte leaves. Direction "in" — the model comes
    // TO the machine. Metadata only (host + label), never a URL/query/body.
    const base = { kind: "fetch" as const, host, task: `Downloading ${gguf.filename}`, direction: "in" as const };
    await sink.append({ ...base, ts: new Date().toISOString(), bytesSent: 0, bytesReceived: 0, ok: false, phase: "sent" });

    await mkdir(modelsDir(), { recursive: true });
    let hash = createHash("sha256");
    // Resume: re-hash the existing partial so the final gate covers the whole file.
    // ponytail: re-hashes the whole partial each resume — fine for a one-shot resume;
    // persist a rolling hash if flappy-network multi-resumes ever get common.
    let received = already > 0 ? await rehashExisting(part, hash) : 0;

    async function doneReceipt(ok: boolean): Promise<void> {
      try {
        await sink.append({ ...base, ts: new Date().toISOString(), bytesSent: 0, bytesReceived: received, ok, phase: "done" });
      } catch {
        // the "sent" line already made the egress non-repudiable
      }
    }

    try {
      // Ask only for the missing tail if we're resuming. A server that ignores the Range
      // (answers 200, not 206) means we must start clean — reset the hash + truncate.
      let res = await fetchImpl(gguf.url, received > 0 ? { headers: { Range: `bytes=${received}-` } } : undefined);
      if (received > 0 && res.status !== 206) {
        hash = createHash("sha256");
        received = 0;
        if (res.status !== 200) res = await fetchImpl(gguf.url); // e.g. 416 → refetch whole
      }
      if (!res.ok || !res.body) {
        throw new Error(`The download couldn't start (error ${res.status}). Try again.`);
      }
      // The FINAL url (after any redirect) must stay https — a redirect can't downgrade an
      // https catalog link to plain http. Loopback http is allowed only unpackaged (fixture).
      if (res.url && !isSafeFinalUrl(res.url, !app.isPackaged)) {
        throw new Error("The download was sent to an insecure address and was stopped.");
      }
      const total = gguf.sizeBytes;
      const out = createWriteStream(part, { flags: received > 0 ? "a" : "w" });
      // A write error (e.g. the disk fills after the pre-check, from another process) must
      // REJECT this download cleanly — never surface as an unhandled 'error' on the writable
      // that crashes main. Race every await against it; the noop .catch keeps a late error
      // (after we've already finished) from becoming an unhandled rejection.
      const streamError = new Promise<never>((_, reject) => out.once("error", reject));
      streamError.catch(() => {});
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      try {
        for (;;) {
          const { done, value } = await Promise.race([reader.read(), streamError]);
          if (done) break;
          if (!value) continue;
          hash.update(value);
          received += value.byteLength;
          // backpressure, never buffer the whole body
          if (!out.write(value)) await Promise.race([new Promise((r) => out.once("drain", r)), streamError]);
          onProgress?.({
            completed: received,
            total,
            percent: total > 0 ? Math.max(0, Math.min(100, Math.round((received / total) * 100))) : 0,
          });
        }
      } finally {
        reader.releaseLock();
      }
      await Promise.race([
        new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve()))),
        streamError,
      ]);
    } catch (err) {
      // Leave the `.part` in place — a later call resumes it. (A hash mismatch below is
      // the one case we DO delete, since the bytes themselves are wrong.)
      await doneReceipt(false);
      throw err instanceof Error ? err : new Error("The download didn't finish. Try again.");
    }

    // The sha256 gate — the load-bearing integrity check. A mismatch deletes the `.part`
    // (its bytes are wrong — resuming can't fix that) and rejects; the real `dest` was
    // never created, so a bad file can't be loaded.
    const digest = hash.digest("hex");
    if (digest !== gguf.sha256.toLowerCase()) {
      await unlink(part).catch(() => {});
      await doneReceipt(false);
      throw new Error("The downloaded model didn't match its safety check and was removed. Try again.");
    }

    // Verified → give it its real name. Only now does modelDownloaded() see it.
    await rename(part, dest);
    await doneReceipt(true);
    return dest;
  } finally {
    inFlight.delete(dest);
  }
}

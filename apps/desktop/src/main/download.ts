import { app } from "electron";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { FetchSink, GgufSource } from "@deskhand/core";

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
// The download URL may 302 to a CDN (Hugging Face does); we follow redirects (default
// fetch behavior) and rely on https-only + the sha256 gate for integrity, not on
// pinning the first host.

const SAFE_GGUF_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.gguf$/;

// Loopback is on-machine (a dev/test fixture); everything else must stay https so a
// redirect can't DOWNGRADE the transport (a 302 from an https catalog url to http).
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
function isSafeFinalUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
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

export interface DownloadProgress {
  completed: number;
  total: number;
  /** 0–100 for the progress bar. */
  percent: number;
}

/** Download + verify a GGUF, returning its on-disk path. Rejects (descriptively,
 *  leaving no partial file) on any failure or a hash mismatch. */
export async function downloadModel(
  gguf: GgufSource,
  sink: FetchSink,
  onProgress?: (p: DownloadProgress) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const dest = modelPath(gguf.filename); // throws on an unsafe name before anything else
  // Download to a `.part` file and rename to the real name ONLY after the sha256 passes.
  // So a corrupt/tampered download NEVER exists under `dest` — even if cleanup fails, the
  // final name is created only for a verified file, and can never be loaded otherwise.
  const part = dest + ".part";

  // https-only: an untrusted catalog url can't be http/file/etc.
  let host: string;
  try {
    const u = new URL(gguf.url);
    if (u.protocol !== "https:") throw new Error("not https");
    host = u.host;
  } catch {
    throw new Error("This model's download link isn't a secure https link.");
  }

  // Fail-closed egress receipt BEFORE any byte leaves. Direction "in" — the model comes
  // TO the machine. Metadata only (host + label), never a URL/query/body.
  const base = { kind: "fetch" as const, host, task: `Downloading ${gguf.filename}`, direction: "in" as const };
  await sink.append({ ...base, ts: new Date().toISOString(), bytesSent: 0, bytesReceived: 0, ok: false, phase: "sent" });

  await mkdir(modelsDir(), { recursive: true });
  const hash = createHash("sha256");
  let received = 0;

  async function doneReceipt(ok: boolean): Promise<void> {
    try {
      await sink.append({ ...base, ts: new Date().toISOString(), bytesSent: 0, bytesReceived: received, ok, phase: "done" });
    } catch {
      // the "sent" line already made the egress non-repudiable
    }
  }

  try {
    const res = await fetchImpl(gguf.url); // follows the HF 302 → CDN
    if (!res.ok || !res.body) {
      throw new Error(`The download couldn't start (error ${res.status}). Try again.`);
    }
    // The FINAL url (after any redirect) must stay https (loopback allowed for the dev
    // fixture) — a redirect can't downgrade an https catalog link to plain http.
    if (res.url && !isSafeFinalUrl(res.url)) {
      throw new Error("The download was sent to an insecure address and was stopped.");
    }
    const total = gguf.sizeBytes;
    const out = createWriteStream(part);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        hash.update(value);
        received += value.byteLength;
        if (!out.write(value)) await new Promise((r) => out.once("drain", r)); // backpressure, never buffer whole
        onProgress?.({
          completed: received,
          total,
          percent: total > 0 ? Math.max(0, Math.min(100, Math.round((received / total) * 100))) : 0,
        });
      }
    } finally {
      reader.releaseLock();
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch (err) {
    await unlink(part).catch(() => {}); // no partial file left behind
    await doneReceipt(false);
    throw err instanceof Error ? err : new Error("The download didn't finish. Try again.");
  }

  // The sha256 gate — the load-bearing integrity check. A mismatch deletes the `.part`
  // and rejects; the real `dest` was never created, so a bad file can't be loaded.
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
}

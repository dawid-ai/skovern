import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchReceipt, FetchSink, GgufSource } from "@skovern/core";

// A controllable userData dir so modelsDir() points at a temp folder.
const state = { dir: "" };
vi.mock("electron", () => ({ app: { getPath: () => state.dir } }));

// A seam to force a WRITE-stream error mid-download (simulating e.g. a disk that fills
// after the pre-check). The wrapper is a passthrough unless `writeStreamError` is set.
const fsControl = vi.hoisted(() => ({ writeStreamError: null as Error | null }));
vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  return {
    ...actual,
    createWriteStream: (p: string, o?: unknown) => {
      const s = actual.createWriteStream(p, o as never);
      if (fsControl.writeStreamError) {
        const err = fsControl.writeStreamError;
        queueMicrotask(() => s.emit("error", err));
      }
      return s;
    },
  };
});

import { DownloadError, STOPPED_PARTWAY, downloadModel, ensureDiskSpace, isSafeFinalUrl, modelDownloaded, modelPath, modelsDir, sweepOrphanParts } from "./download.js";

let server: Server | null = null;

// Serve `body` (optionally in N chunks so a streamed read sees many reads). Returns a
// base url; the caller appends the filename path.
function startServer(body: Buffer, opts: { status?: number; chunks?: number } = {}): Promise<string> {
  const status = opts.status ?? 200;
  const chunks = opts.chunks ?? 1;
  return new Promise((resolve) => {
    server = createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/octet-stream" });
      if (status !== 200) return res.end("error");
      const size = Math.ceil(body.length / chunks);
      let i = 0;
      const writeNext = (): void => {
        if (i >= body.length) {
          res.end();
          return;
        }
        res.write(body.subarray(i, i + size));
        i += size;
        setImmediate(writeNext); // spread across ticks so the reader sees separate chunks
      };
      writeNext();
    });
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`));
  });
}

function sha256(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

function collectingSink(): { sink: FetchSink; receipts: FetchReceipt[] } {
  const receipts: FetchReceipt[] = [];
  return { sink: { append: (r) => void receipts.push(r) }, receipts };
}

// The catalog url must be https (validated), but a real https fixture server is awkward.
// So the url is a dummy https link (passes validation) and tests inject a fetchImpl that
// streams from the real http fixture — decoupling URL-validation from the transfer.
function gguf(body: Buffer, filename = "test-model.gguf"): GgufSource {
  return { url: `https://model.test/${filename}`, sha256: sha256(body), sizeBytes: body.length, filename, contextSize: 4096 };
}
function via(base: string): typeof fetch {
  return (() => fetch(base)) as typeof fetch;
}
// Forwards the request init (so the Range header reaches the fixture) to a real server.
function viaRange(base: string): typeof fetch {
  return ((_url, init) => fetch(base, init)) as typeof fetch;
}

// A Range-aware fixture: honors `Range: bytes=N-` with a 206 (records N), or ignores it
// (always 200 full body) when `ignoreRange` — the "server can't resume" fallback path.
function startRangeServer(body: Buffer, opts: { ignoreRange?: boolean } = {}): Promise<{ base: string; servedFrom: () => number | null }> {
  let servedFrom: number | null = null;
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const range = req.headers["range"];
      const m = range ? /bytes=(\d+)-/.exec(String(range)) : null;
      let start = 0;
      if (m && !opts.ignoreRange) {
        start = Number(m[1]);
        servedFrom = start;
        res.writeHead(206, { "content-range": `bytes ${start}-${body.length - 1}/${body.length}`, "content-type": "application/octet-stream" });
      } else {
        servedFrom = null; // whole body from 0
        res.writeHead(200, { "content-type": "application/octet-stream" });
      }
      const slice = body.subarray(start);
      const size = Math.max(1, Math.ceil(slice.length / 6)); // several ticks so streaming is real
      let i = 0;
      const writeNext = (): void => {
        if (i >= slice.length) return void res.end();
        res.write(slice.subarray(i, i + size));
        i += size;
        setImmediate(writeNext);
      };
      writeNext();
    });
    server.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, servedFrom: () => servedFrom }));
  });
}

beforeEach(() => {
  state.dir = mkdtempSync(path.join(tmpdir(), "skovern-dl-"));
});
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  rmSync(state.dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("downloadModel", () => {
  // D1 — sha256 GATE: a body matching the catalog hash lands on disk with an ok "done"
  // receipt; the returned path is the model file.
  it("D1: writes the file and an ok receipt when the sha256 matches", async () => {
    const body = Buffer.from("a fake gguf payload".repeat(100));
    const base = await startServer(body);
    const g = gguf(body);
    const { sink, receipts } = collectingSink();

    const dest = await downloadModel(g, sink, undefined, via(base));
    expect(dest).toBe(modelPath(g.filename));
    expect(readFileSync(dest)).toEqual(body);
    expect(receipts.some((r) => r.phase === "sent")).toBe(true);
    expect(receipts.some((r) => r.phase === "done" && r.ok === true)).toBe(true);
    expect(modelDownloaded(g.filename)).toBe(true);
  });

  // D2 — sha256 GATE (security-critical, negative): a body whose hash does NOT match is
  // rejected with a specific reason AND leaves no file behind — a tampered/corrupt model
  // never survives to be loaded.
  it("D2: rejects and deletes the file when the sha256 does NOT match", async () => {
    const body = Buffer.from("the real payload");
    const base = await startServer(body);
    // Expect a DIFFERENT hash than what the server actually serves.
    const g: GgufSource = { url: "https://model.test/tampered.gguf", sha256: "0".repeat(64), sizeBytes: body.length, filename: "tampered.gguf", contextSize: 4096 };
    const { sink } = collectingSink();

    await expect(downloadModel(g, sink, undefined, via(base))).rejects.toThrow(/safety check|didn't match/i);
    expect(existsSync(modelPath(g.filename))).toBe(false); // real name never created
    expect(readdirSync(modelsDir())).toHaveLength(0); // no .part.N orphan either
    expect(modelDownloaded(g.filename)).toBe(false);
  });

  // D3 — fail-closed: the "sent" egress receipt is durable BEFORE any byte leaves; a
  // throwing sink makes downloadModel reject AND never fetch.
  it("D3: a throwing sink rejects the download and never fetches", async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    const sink: FetchSink = {
      append: () => {
        throw new Error("disk full");
      },
    };
    const g = gguf(Buffer.from("x"));
    // 045: the sink's raw error text no longer reaches the user (it's not one of ours) — the
    // download still REJECTS, and still never fetches, which is what this test guards.
    const err = await downloadModel(g, sink, undefined, fetchSpy).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownloadError);
    expect((err as Error).message).not.toMatch(/disk full/);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  // D4 — streaming, not whole-body-buffered: a body delivered in many chunks produces
  // multiple progress ticks and a byte-exact file — proving chunk-by-chunk streaming
  // (never a single arrayBuffer of the whole body, which would OOM on a 2 GB model).
  it("D4: streams the body in chunks, forwarding progress", async () => {
    const body = Buffer.alloc(240 * 1024, 7); // 240 KB
    const base = await startServer(body, { chunks: 12 });
    const g = gguf(body, "big.gguf");
    const { sink } = collectingSink();
    const ticks: number[] = [];

    const dest = await downloadModel(g, sink, (p) => ticks.push(p.completed), via(base));
    expect(readFileSync(dest).length).toBe(body.length);
    expect(ticks.length).toBeGreaterThan(1); // many reads, not one buffered blob
    expect(ticks[ticks.length - 1]).toBe(body.length); // last tick == full size
    // strictly increasing bytes-received
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]!).toBeGreaterThan(ticks[i - 1]!);
  });

  // D5 — non-https url refused (untrusted catalog link can't be http/file/etc).
  it("D5: refuses a non-https download url", async () => {
    const g: GgufSource = { url: "http://insecure.test/model.gguf", sha256: "0".repeat(64), sizeBytes: 1, filename: "x.gguf", contextSize: 4096 };
    const { sink } = collectingSink();
    await expect(downloadModel(g, sink)).rejects.toThrow(/secure https/i);
  });

  // D7 — redirect downgrade: a fetch that ends on a non-loopback http host (an https
  // catalog link 302'd to plain http) is refused, leaving no file — the transport can't
  // be silently downgraded.
  it("D7: refuses a final url that downgraded to non-loopback http", async () => {
    const g = gguf(Buffer.from("x"), "redir.gguf"); // g.url is https (passes the first check)
    const { sink } = collectingSink();
    const fakeRes = {
      ok: true,
      status: 200,
      url: "http://evil.test/redir.gguf", // the FINAL url after a downgrade redirect
      body: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
    } as unknown as Response;
    const fetchImpl = (() => Promise.resolve(fakeRes)) as unknown as typeof fetch;
    await expect(downloadModel(g, sink, undefined, fetchImpl)).rejects.toThrow(/insecure address/i);
    expect(existsSync(modelPath(g.filename))).toBe(false);
  });

  // D8 — final-url safety gates http to loopback, and ONLY unpackaged: a packaged app
  // (allowLoopback=false) is https-only even for the redirect target.
  it("D8: isSafeFinalUrl allows loopback http only when unpackaged", () => {
    expect(isSafeFinalUrl("https://huggingface.co/x.gguf", false)).toBe(true);
    expect(isSafeFinalUrl("http://127.0.0.1:8080/x.gguf", true)).toBe(true); // dev fixture
    expect(isSafeFinalUrl("http://127.0.0.1:8080/x.gguf", false)).toBe(false); // packaged → https-only
    expect(isSafeFinalUrl("http://evil.test/x.gguf", true)).toBe(false); // non-loopback http never
  });

  // D6 — no path traversal: a filename that escapes the models dir is refused before it
  // ever becomes a path (defense-in-depth; the catalog validator also drops these).
  it("D6: modelPath refuses a traversing filename", () => {
    expect(() => modelPath("../evil.gguf")).toThrow(/isn't allowed/i);
    expect(() => modelPath("sub/dir.gguf")).toThrow(/isn't allowed/i);
    // a good name resolves under the models dir
    expect(modelPath("ok.gguf")).toBe(path.join(modelsDir(), "ok.gguf"));
  });
});

describe("download robustness (loop 029)", () => {
  // R1 — RESUME across restarts: a pre-seeded correct-prefix `.part` resumes via Range,
  // the server serves ONLY the missing tail, and the reassembled file passes the gate.
  it("R1: resumes a partial download, fetching only the missing tail", async () => {
    const body = Buffer.alloc(120 * 1024, 9); // 120 KB
    const g = gguf(body, "resume.gguf");
    // Pre-seed the first 40 KB as if a prior run had been interrupted.
    mkdirSync(modelsDir(), { recursive: true });
    const seeded = 40 * 1024;
    writeFileSync(`${modelPath(g.filename)}.part`, body.subarray(0, seeded));

    const { base, servedFrom } = await startRangeServer(body);
    const { sink } = collectingSink();
    const dest = await downloadModel(g, sink, undefined, viaRange(base));

    expect(servedFrom()).toBe(seeded); // asked the server for bytes 40K- only
    expect(readFileSync(dest)).toEqual(body); // reassembled file is byte-exact
    expect(existsSync(`${modelPath(g.filename)}.part`)).toBe(false); // renamed away
  });

  // R1b — resume SAFETY: a server that ignores Range (200, not 206) forces a clean
  // restart, and the result still passes the sha256 gate (no stale-prefix corruption).
  it("R1b: restarts cleanly when the server ignores Range", async () => {
    const body = Buffer.alloc(80 * 1024, 5);
    const g = gguf(body, "norange.gguf");
    mkdirSync(modelsDir(), { recursive: true });
    writeFileSync(`${modelPath(g.filename)}.part`, body.subarray(0, 20 * 1024));

    const { base, servedFrom } = await startRangeServer(body, { ignoreRange: true });
    const { sink } = collectingSink();
    const dest = await downloadModel(g, sink, undefined, viaRange(base));

    expect(servedFrom()).toBeNull(); // whole body, not a range
    expect(readFileSync(dest)).toEqual(body); // clean restart → correct bytes, gate passes
  });

  // R1c — a WRONG partial (not a prefix of the real bytes) is caught by the sha256 gate:
  // the resumed file mismatches and is deleted, never loaded.
  it("R1c: a corrupt partial is caught by the sha256 gate on resume", async () => {
    const body = Buffer.alloc(60 * 1024, 3);
    const g = gguf(body, "corrupt.gguf");
    mkdirSync(modelsDir(), { recursive: true });
    // Seed 20 KB of WRONG bytes (0xFF), so resume appends the tail onto a bad prefix.
    writeFileSync(`${modelPath(g.filename)}.part`, Buffer.alloc(20 * 1024, 0xff));

    const { base } = await startRangeServer(body);
    const { sink } = collectingSink();
    await expect(downloadModel(g, sink, undefined, viaRange(base))).rejects.toThrow(/safety check|didn't match/i);
    expect(existsSync(modelPath(g.filename))).toBe(false); // never loaded
    expect(existsSync(`${modelPath(g.filename)}.part`)).toBe(false); // bad bytes removed
  });

  // R2 — DISK pre-check (degraded state): when free space can't hold the model, the pull
  // is refused BEFORE any byte leaves (fetch never called), with a florist-copy message.
  it("R2: refuses the download when there isn't enough disk space", async () => {
    const g = gguf(Buffer.from("x".repeat(1000)), "toobig.gguf");
    const { sink } = collectingSink();
    const fetchSpy = vi.fn<typeof fetch>();
    const tinyFree = async (): Promise<number> => 10; // 10 bytes free, model needs ~1 KB + margin
    await expect(downloadModel(g, sink, undefined, fetchSpy, tinyFree)).rejects.toThrow(/enough free space/i);
    expect(fetchSpy).toHaveBeenCalledTimes(0); // no byte left the machine
  });

  // R2b — the disk check is permissive when it can't measure (Infinity) and strict when
  // it can (direct unit — the exact threshold behavior).
  it("R2b: ensureDiskSpace blocks only when the measured free space is short", async () => {
    await expect(ensureDiskSpace(1000, async () => Number.POSITIVE_INFINITY)).resolves.toBeUndefined();
    await expect(ensureDiskSpace(1000, async () => 10)).rejects.toThrow(/enough free space/i);
  });

  // R2c — a WRITE error mid-download (e.g. the disk fills after the pre-check) rejects
  // CLEANLY, never surfacing as an unhandled 'error' on the writable that crashes main.
  it("R2c: a mid-stream write error rejects cleanly instead of crashing", async () => {
    const body = Buffer.alloc(80 * 1024, 4);
    const base = await startServer(body, { chunks: 8 });
    const g = gguf(body, "writefail.gguf");
    const { sink } = collectingSink();
    // A real fs write error carries `code: "ENOSPC"`. 045: it now reads as the plain disk-space
    // message (not the raw `ENOSPC …` text) — still a clean rejection, never a crash.
    fsControl.writeStreamError = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    try {
      await expect(downloadModel(g, sink, undefined, via(base))).rejects.toThrow(/enough free space/i);
    } finally {
      fsControl.writeStreamError = null;
    }
    expect(existsSync(modelPath(g.filename))).toBe(false); // no bad model file
  });

  // R3 — ORPHAN sweep: stale `.part`/`.part.<n>` temps are removed, but a resumable
  // `<f>.part` for a current model, a finished `.gguf`, and a model whose NAME contains
  // "part" are all left untouched.
  it("R3: sweeps stale part files but keeps resumable + finished ones", async () => {
    mkdirSync(modelsDir(), { recursive: true });
    const write = (name: string): void => writeFileSync(path.join(modelsDir(), name), "x");
    write("a.gguf"); // finished model → keep
    write("a.gguf.part"); // resumable for a current model → keep
    write("my.part.gguf"); // model whose name contains "part" → keep (not a temp)
    write("old.gguf.part.3"); // legacy unique-name orphan → remove
    write("gone.gguf.part"); // partial for a model no longer known → remove

    const removed = await sweepOrphanParts(["a.gguf", "my.part.gguf"]);

    expect(removed).toBe(2);
    const left = readdirSync(modelsDir()).sort();
    expect(left).toEqual(["a.gguf", "a.gguf.part", "my.part.gguf"]);
  });
});

// Loop 045 B2 — a raw network error never reaches the user; our own reasons still do.
describe("download errors speak plain language (loop 045)", () => {
  // A server that sends HALF the body then drops the connection — exactly what makes undici throw
  // its raw `TypeError: terminated` mid-stream (Dawid's first-download failure).
  function startDroppingServer(body: Buffer): Promise<string> {
    return new Promise((resolve) => {
      server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.length) });
        res.write(body.subarray(0, body.length / 2), () => setImmediate(() => res.socket?.destroy()));
      });
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`));
    });
  }

  it("U8: a connection dropped mid-stream → the florist message, never the word 'terminated'", async () => {
    const body = Buffer.alloc(256 * 1024, 7);
    const base = await startDroppingServer(body);
    const g = gguf(body, "dropped.gguf");
    const err = await downloadModel(g, collectingSink().sink, undefined, via(base)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownloadError);
    expect((err as Error).message).toBe(STOPPED_PARTWAY);
    expect((err as Error).message).not.toMatch(/terminated/i);
    expect((err as Error).message).not.toContain("127.0.0.1"); // no host/url leaks either
  });

  it("U9: our own plain-language refusals still pass through verbatim", async () => {
    const { sink } = collectingSink();
    await expect(downloadModel({ ...gguf(Buffer.from("x")), url: "http://model.test/x.gguf" }, sink)).rejects.toThrow(
      "This model's download link isn't a secure https link.",
    );
    await expect(downloadModel(gguf(Buffer.from("x"), "nospace.gguf"), sink, undefined, vi.fn<typeof fetch>(), async () => 0)).rejects.toThrow(
      "There isn't enough free space on this computer for this model. Free up some room and try again.",
    );
    const body = Buffer.from("real");
    const base = await startServer(body);
    const bad: GgufSource = { ...gguf(body, "bad.gguf"), sha256: "0".repeat(64) };
    await expect(downloadModel(bad, sink, undefined, via(base))).rejects.toThrow(
      "The downloaded model didn't match its safety check and was removed. Try again.",
    );
  });

  it("U10: the .part survives a dropped connection, and Try again resumes it to a good file", async () => {
    const body = Buffer.alloc(256 * 1024, 5);
    const g = gguf(body, "resumable.gguf");
    const base = await startDroppingServer(body);
    await expect(downloadModel(g, collectingSink().sink, undefined, via(base))).rejects.toThrow(STOPPED_PARTWAY);
    expect(existsSync(`${modelPath(g.filename)}.part`)).toBe(true); // kept for the resume
    await new Promise<void>((r) => server!.close(() => r()));
    const { base: rangeBase, servedFrom } = await startRangeServer(body);
    const dest = await downloadModel(g, collectingSink().sink, undefined, viaRange(rangeBase));
    expect(servedFrom()).toBeGreaterThan(0); // picked up where it left off
    expect(readFileSync(dest)).toEqual(body);
  });
});

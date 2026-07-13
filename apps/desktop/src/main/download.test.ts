import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchReceipt, FetchSink, GgufSource } from "@deskhand/core";

// A controllable userData dir so modelsDir() points at a temp folder.
const state = { dir: "" };
vi.mock("electron", () => ({ app: { getPath: () => state.dir } }));

import { downloadModel, modelDownloaded, modelPath, modelsDir } from "./download.js";

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

beforeEach(() => {
  state.dir = mkdtempSync(path.join(tmpdir(), "deskhand-dl-"));
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
    expect(existsSync(modelPath(g.filename) + ".part")).toBe(false); // and no .part orphan
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
    await expect(downloadModel(g, sink, undefined, fetchSpy)).rejects.toThrow(/disk full/);
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

  // D6 — no path traversal: a filename that escapes the models dir is refused before it
  // ever becomes a path (defense-in-depth; the catalog validator also drops these).
  it("D6: modelPath refuses a traversing filename", () => {
    expect(() => modelPath("../evil.gguf")).toThrow(/isn't allowed/i);
    expect(() => modelPath("sub/dir.gguf")).toThrow(/isn't allowed/i);
    // a good name resolves under the models dir
    expect(modelPath("ok.gguf")).toBe(path.join(modelsDir(), "ok.gguf"));
  });
});

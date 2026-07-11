import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchReceipt, FetchSink, Receipt } from "@deskhand/core";

// Mock Electron: a controllable userData dir so receiptsFile() points at a temp
// file. safeStorage is unused here but stubbed so the import resolves.
const state = { dir: "" };

vi.mock("electron", () => ({
  app: { getPath: () => state.dir },
}));

import { fileFetchSink, fileReceiptSink, readReceipts, receiptedFetch } from "./receipts.js";

function receiptsPath(): string {
  return path.join(state.dir, "receipts.jsonl");
}

function rotatedPath(): string {
  return receiptsPath() + ".1";
}

// Mirrors MAX_BYTES in receipts.ts (kept private there — this is the cap under test).
const MAX_BYTES = 2 * 1024 * 1024;

// A model receipt with a padded task so a few lines cross the cap fast in tests.
function modelReceipt(task: string, pad = 0): Receipt {
  return {
    ts: "2026-07-11T10:00:00.000Z",
    provider: "openrouter",
    model: "m",
    task: pad > 0 ? task + "-" + "x".repeat(pad) : task,
    bytesSent: 1,
    bytesReceived: 0,
    ok: true,
    phase: "sent",
  };
}

const FAKE_CRED = "sk-fake-cred-should-never-be-logged";

beforeEach(() => {
  state.dir = mkdtempSync(path.join(tmpdir(), "deskhand-receipts-"));
});

afterEach(() => {
  rmSync(state.dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("readReceipts", () => {
  it("returns [] when the log doesn't exist yet", async () => {
    expect(await readReceipts()).toEqual([]);
  });

  // R1 — robust read: a half-written line (crash mid-append) is skipped, the good
  // line beside it survives. The panel never breaks on a corrupt line.
  it("R1: skips a malformed line and keeps the good one", async () => {
    const good = { ts: "2026-07-11T10:00:00.000Z", provider: "openrouter", model: "m", task: "Test my brain", bytesSent: 5, bytesReceived: 9, ok: true, phase: "done" };
    const broken = '{"ts":"2026-07-11T10:00:01.000Z","kind":"fetch","host":"api.desk'; // no closing brace
    writeFileSync(receiptsPath(), `${JSON.stringify(good)}\n${broken}\n`);

    const out = await readReceipts();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ provider: "openrouter", task: "Test my brain" });
  });

  // R2 — bounded + newest-first: a huge log yields at most 500 receipts, and the
  // ones returned are the newest, in newest-first order.
  it("R2: returns at most the last 500, newest first", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 700; i++) {
      lines.push(
        JSON.stringify({
          ts: `2026-07-11T10:00:00.${String(i).padStart(3, "0")}Z`,
          kind: "fetch",
          host: "api.deskhand.test",
          task: `Deskhand: n${i}`,
          bytesSent: i,
          bytesReceived: 0,
          ok: true,
          phase: "done",
        }),
      );
    }
    writeFileSync(receiptsPath(), lines.join("\n") + "\n");

    const out = await readReceipts();
    expect(out).toHaveLength(500);
    // newest-first: index 0 is the very last line written (n699), and the oldest
    // kept is n200 (the first 200 were dropped by the 500 cap).
    expect(out[0]).toMatchObject({ task: "Deskhand: n699" });
    expect(out[499]).toMatchObject({ task: "Deskhand: n200" });
  });
});

describe("receiptedFetch", () => {
  function collectingSink(): { sink: FetchSink; receipts: FetchReceipt[] } {
    const receipts: FetchReceipt[] = [];
    return { sink: { append: (r) => void receipts.push(r) }, receipts };
  }

  // S1 — no secrets in receipts: a call to a URL with a ?token=FAKE_CRED query and an
  // authorization: Bearer FAKE_CRED header produces receipts whose serialized JSON
  // contains neither the secret, the query string, nor "authorization".
  it("S1: records host + label + bytes only — never the secret, query, or header", async () => {
    const { sink, receipts } = collectingSink();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));

    const wrapped = receiptedFetch(sink, "Deskhand: messages");
    await wrapped(`https://cloud.deskhand.test/dm?token=${FAKE_CRED}`, {
      method: "POST",
      headers: { authorization: `Bearer ${FAKE_CRED}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(receipts.length).toBeGreaterThanOrEqual(1);
    const serialized = JSON.stringify(receipts);
    expect(serialized).not.toContain(FAKE_CRED);
    expect(serialized).not.toContain("token=");
    expect(serialized).not.toContain("authorization");
    // what it DOES carry: host (not the path/query), the label, and byte counts
    for (const r of receipts) {
      expect(r.host).toBe("cloud.deskhand.test");
      expect(r.task).toBe("Deskhand: messages");
      expect(typeof r.bytesSent).toBe("number");
    }
  });

  // S2 — fail-closed: the "sent" receipt is written before the request leaves.
  // With a sink whose append throws, the wrapped fetch rejects AND the underlying
  // fetch was never called — no egress without a durable record.
  it("S2: a throwing sink makes the wrapped fetch reject and never calls fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const sink: FetchSink = {
      append: () => {
        throw new Error("disk full");
      },
    };

    const wrapped = receiptedFetch(sink, "Deskhand: messages");
    await expect(wrapped("https://cloud.deskhand.test/dm")).rejects.toThrow(/disk full/);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });
});

describe("rotation", () => {
  // T1 — rotation on size: once the current log crosses the cap, the next append
  // rotates it to `.1` (holding the pre-rotation content) and starts a fresh, small
  // current file that holds only the new line.
  it("T1: rotates the current log to .1 when it crosses the cap", () => {
    // One oversized line pushes the file past the cap. Distinct ts marks it so we
    // can find it in the rotated file afterwards.
    const before = { ...modelReceipt("before-rotation", MAX_BYTES), ts: "2026-01-01T00:00:00.000Z" };
    writeFileSync(receiptsPath(), JSON.stringify(before) + "\n");
    expect(statSync(receiptsPath()).size).toBeGreaterThanOrEqual(MAX_BYTES);

    const after = { ...modelReceipt("after-rotation"), ts: "2026-02-02T00:00:00.000Z" };
    fileReceiptSink().append(after);

    // .1 now holds the pre-rotation content; current is fresh and small.
    expect(existsSync(rotatedPath())).toBe(true);
    expect(readFileSync(rotatedPath(), "utf8")).toContain("2026-01-01T00:00:00.000Z");
    const current = readFileSync(receiptsPath(), "utf8");
    expect(current).toContain("2026-02-02T00:00:00.000Z");
    expect(current).not.toContain("2026-01-01T00:00:00.000Z");
    expect(statSync(receiptsPath()).size).toBeLessThan(MAX_BYTES);
  });

  // T2 — bounded disk: writing well past 2×cap through the sink leaves exactly two
  // files (.jsonl + .jsonl.1), never a .2, and neither exceeds the cap by more than
  // one receipt-line.
  it("T2: on-disk usage stays bounded to two files, no .2", () => {
    const pad = 20 * 1024; // ~20 KB per line so a few hundred appends cross 2×cap
    const sink = fileReceiptSink();
    let maxLineBytes = 0;
    // Write comfortably past 2×MAX_BYTES of total volume.
    let written = 0;
    let i = 0;
    while (written < 3 * MAX_BYTES) {
      const receipt = modelReceipt("bulk-" + i, pad);
      const bytes = Buffer.byteLength(JSON.stringify(receipt) + "\n");
      maxLineBytes = Math.max(maxLineBytes, bytes);
      sink.append(receipt);
      written += bytes;
      i++;
    }

    expect(existsSync(receiptsPath())).toBe(true);
    expect(existsSync(rotatedPath())).toBe(true);
    expect(existsSync(receiptsPath() + ".2")).toBe(false);
    // Neither file exceeds the cap by more than one line: rotation fires when a file
    // reaches the cap, so the largest a file gets is (just under cap) + one line.
    expect(statSync(receiptsPath()).size).toBeLessThanOrEqual(MAX_BYTES + maxLineBytes);
    expect(statSync(rotatedPath()).size).toBeLessThanOrEqual(MAX_BYTES + maxLineBytes);
  });

  // Windows gotcha: renameSync to an EXISTING target throws on Windows. Rotating
  // when a `.1` already exists must succeed (delete-then-rename), replacing it.
  it("replaces a pre-existing .1 on rotation without throwing", () => {
    const stale = { ...modelReceipt("stale-rotated"), ts: "2020-01-01T00:00:00.000Z" };
    writeFileSync(rotatedPath(), JSON.stringify(stale) + "\n");
    const before = { ...modelReceipt("before", MAX_BYTES), ts: "2026-01-01T00:00:00.000Z" };
    writeFileSync(receiptsPath(), JSON.stringify(before) + "\n");

    expect(() => fileReceiptSink().append({ ...modelReceipt("after"), ts: "2026-02-02T00:00:00.000Z" })).not.toThrow();

    // The old .1 is gone; the fresh .1 holds the just-rotated current log.
    const rotated = readFileSync(rotatedPath(), "utf8");
    expect(rotated).toContain("2026-01-01T00:00:00.000Z");
    expect(rotated).not.toContain("2020-01-01T00:00:00.000Z");
  });

  // The async fetch sink rotates too, and keeps its fsync-before-resolve intact
  // (the append still resolves only after the write lands).
  it("the fetch sink rotates the log before appending", async () => {
    const before = { ...modelReceipt("before", MAX_BYTES), ts: "2026-01-01T00:00:00.000Z" };
    writeFileSync(receiptsPath(), JSON.stringify(before) + "\n");

    const fetchReceipt: FetchReceipt = {
      kind: "fetch",
      ts: "2026-03-03T00:00:00.000Z",
      host: "api.deskhand.test",
      task: "Deskhand: news",
      bytesSent: 5,
      bytesReceived: 0,
      ok: false,
      phase: "sent",
    };
    await fileFetchSink().append(fetchReceipt);

    expect(existsSync(rotatedPath())).toBe(true);
    expect(readFileSync(rotatedPath(), "utf8")).toContain("2026-01-01T00:00:00.000Z");
    expect(readFileSync(receiptsPath(), "utf8")).toContain("2026-03-03T00:00:00.000Z");
  });
});

describe("readReceipts across rotation", () => {
  // T3 — reader spans the boundary: a receipt written just before rotation (last
  // line of `.1`) and one just after (first line of current) are BOTH reachable,
  // newest-first, no gap or dup at the seam.
  it("T3: reads .1 then current, continuous across the seam", async () => {
    const older = [
      { ...modelReceipt("old-a"), ts: "2026-01-01T00:00:00.000Z" },
      { ...modelReceipt("before-seam"), ts: "2026-01-01T00:00:01.000Z" }, // last before rotation
    ];
    const newer = [
      { ...modelReceipt("after-seam"), ts: "2026-01-01T00:00:02.000Z" }, // first after rotation
      { ...modelReceipt("new-b"), ts: "2026-01-01T00:00:03.000Z" },
    ];
    writeFileSync(rotatedPath(), older.map((r) => JSON.stringify(r)).join("\n") + "\n");
    writeFileSync(receiptsPath(), newer.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const out = await readReceipts();
    // newest-first across both files, no gap/dup at the seam.
    expect(out.map((r) => r.task)).toEqual(["new-b", "after-seam", "before-seam", "old-a"]);
    // The seam pair is adjacent and correctly ordered (after newer than before).
    const beforeIdx = out.findIndex((r) => r.task === "before-seam");
    const afterIdx = out.findIndex((r) => r.task === "after-seam");
    expect(afterIdx).toBe(beforeIdx - 1);
  });

  // The newest-500 window is drawn from BOTH files: with 300 in `.1` and 400 in
  // current (700 total), the reader returns the newest 500, oldest kept straddling
  // into the rotated file.
  it("keeps the newest 500 across both files", async () => {
    const older: string[] = [];
    for (let i = 0; i < 300; i++) {
      older.push(JSON.stringify({ ...modelReceipt("o" + String(i).padStart(3, "0")), ts: `2026-01-01T00:00:00.${String(i).padStart(3, "0")}Z` }));
    }
    const newer: string[] = [];
    for (let i = 0; i < 400; i++) {
      newer.push(JSON.stringify({ ...modelReceipt("n" + String(i).padStart(3, "0")), ts: `2026-01-01T00:01:00.${String(i).padStart(3, "0")}Z` }));
    }
    writeFileSync(rotatedPath(), older.join("\n") + "\n");
    writeFileSync(receiptsPath(), newer.join("\n") + "\n");

    const out = await readReceipts();
    expect(out).toHaveLength(500);
    // newest = last current line; oldest kept = 200th-from-end overall = o200 (the
    // window reaches back into the rotated file: 400 current + 100 from `.1`).
    expect(out[0]).toMatchObject({ task: "n399" });
    expect(out[499]).toMatchObject({ task: "o200" });
  });
});

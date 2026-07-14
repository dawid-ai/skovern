import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

import { fileFetchSink, fileReceiptSink, readActivityIndex, readReceipts, receiptedFetch } from "./receipts.js";

function receiptsPath(): string {
  return path.join(state.dir, "receipts.jsonl");
}

function activityPath(): string {
  return path.join(state.dir, "receipts-activity.json");
}

// Loop 027: rotation renames the live log to a UNIQUE dated archive that is NEVER
// deleted. These list the archives that exist (the live file excluded).
function archiveFiles(): string[] {
  return readdirSync(state.dir).filter((f) => f.startsWith("receipts.") && f.endsWith(".jsonl") && f !== "receipts.jsonl");
}
function archivePath(name: string): string {
  return path.join(state.dir, name);
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

describe("rotation → durable archive (full retention)", () => {
  // T1 — rotation on size: once the current log crosses the cap, the next append
  // renames it to a dated ARCHIVE (holding the pre-rotation content) and starts a
  // fresh, small current file. Full retention → the archive is kept, not deleted.
  it("T1: rotates the current log to a dated archive when it crosses the cap", async () => {
    const before = { ...modelReceipt("before-rotation", MAX_BYTES), ts: "2026-01-01T00:00:00.000Z" };
    writeFileSync(receiptsPath(), JSON.stringify(before) + "\n");
    expect(statSync(receiptsPath()).size).toBeGreaterThanOrEqual(MAX_BYTES);

    const after = { ...modelReceipt("after-rotation"), ts: "2026-02-02T00:00:00.000Z" };
    await fileReceiptSink().append(after);

    // Exactly one archive now holds the pre-rotation content; current is fresh + small.
    const archives = archiveFiles();
    expect(archives).toHaveLength(1);
    expect(readFileSync(archivePath(archives[0]!), "utf8")).toContain("2026-01-01T00:00:00.000Z");
    const current = readFileSync(receiptsPath(), "utf8");
    expect(current).toContain("2026-02-02T00:00:00.000Z");
    expect(current).not.toContain("2026-01-01T00:00:00.000Z");
    expect(statSync(receiptsPath()).size).toBeLessThan(MAX_BYTES);
  });

  // T2 — full retention: many rotations accumulate MANY archives, NONE deleted, so no
  // history is ever lost (the whole point of the 027 retention change vs. the old
  // delete-oldest `.1`). Each archive holds its own generation's content.
  it("T2: repeated rotations keep every archive, losing no history", async () => {
    const pad = 20 * 1024;
    const sink = fileReceiptSink();
    // Drive several rotations by writing well past 3×MAX_BYTES.
    let written = 0;
    let i = 0;
    while (written < 4 * MAX_BYTES) {
      const receipt = modelReceipt("bulk-" + i, pad);
      written += Buffer.byteLength(JSON.stringify(receipt) + "\n");
      await sink.append(receipt);
      i++;
    }
    // More than one archive survives (old delete-oldest would have left at most one).
    expect(archiveFiles().length).toBeGreaterThanOrEqual(2);
    // The very first receipt is still on disk somewhere (never deleted).
    const everywhere = [receiptsPath(), ...archiveFiles().map(archivePath)].map((f) => readFileSync(f, "utf8")).join("");
    expect(everywhere).toContain("bulk-0");
  });

  // The async fetch sink rotates too, keeping its fsync-before-resolve intact.
  it("the fetch sink rotates the log to an archive before appending", async () => {
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

    const archives = archiveFiles();
    expect(archives).toHaveLength(1);
    expect(readFileSync(archivePath(archives[0]!), "utf8")).toContain("2026-01-01T00:00:00.000Z");
    expect(readFileSync(receiptsPath(), "utf8")).toContain("2026-03-03T00:00:00.000Z");
  });
});

describe("readReceipts across the rotation seam", () => {
  // T3 — the panel reader spans the newest archive + live: a receipt in the most-recent
  // archive and one in the live file are both reachable, newest-first, no gap/dup.
  it("T3: reads the most-recent archive then live, continuous across the seam", async () => {
    const older = [
      { ...modelReceipt("old-a"), ts: "2026-01-01T00:00:00.000Z" },
      { ...modelReceipt("before-seam"), ts: "2026-01-01T00:00:01.000Z" },
    ];
    const newer = [
      { ...modelReceipt("after-seam"), ts: "2026-01-01T00:00:02.000Z" },
      { ...modelReceipt("new-b"), ts: "2026-01-01T00:00:03.000Z" },
    ];
    // A real archive name (basic-ISO) so allLogFiles picks it up as the newest archive.
    writeFileSync(archivePath("receipts.20260101T000001Z.jsonl"), older.map((r) => JSON.stringify(r)).join("\n") + "\n");
    writeFileSync(receiptsPath(), newer.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const out = await readReceipts();
    expect(out.map((r) => r.task)).toEqual(["new-b", "after-seam", "before-seam", "old-a"]);
    const beforeIdx = out.findIndex((r) => r.task === "before-seam");
    const afterIdx = out.findIndex((r) => r.task === "after-seam");
    expect(afterIdx).toBe(beforeIdx - 1);
  });

  // The newest-500 window spans the most-recent archive + live: 300 archived + 400 live
  // (700 total) → the newest 500, oldest kept reaching back into the archive.
  it("keeps the newest 500 across the newest archive + live", async () => {
    const older: string[] = [];
    for (let i = 0; i < 300; i++) {
      older.push(JSON.stringify({ ...modelReceipt("o" + String(i).padStart(3, "0")), ts: `2026-01-01T00:00:00.${String(i).padStart(3, "0")}Z` }));
    }
    const newer: string[] = [];
    for (let i = 0; i < 400; i++) {
      newer.push(JSON.stringify({ ...modelReceipt("n" + String(i).padStart(3, "0")), ts: `2026-01-01T00:01:00.${String(i).padStart(3, "0")}Z` }));
    }
    writeFileSync(archivePath("receipts.20260101T000100Z.jsonl"), older.join("\n") + "\n");
    writeFileSync(receiptsPath(), newer.join("\n") + "\n");

    const out = await readReceipts();
    expect(out).toHaveLength(500);
    expect(out[0]).toMatchObject({ task: "n399" });
    expect(out[499]).toMatchObject({ task: "o200" });
  });

  // Over-cap-line defense: a single line larger than the reader's per-line ceiling is
  // dropped (never buffered whole), and the good lines around it survive.
  it("skips a line past the per-line byte cap and keeps its neighbours", async () => {
    const good1 = { ...modelReceipt("good-1"), ts: "2026-01-01T00:00:00.000Z" };
    const good2 = { ...modelReceipt("good-2"), ts: "2026-01-01T00:00:02.000Z" };
    const monster = JSON.stringify({ ...modelReceipt("monster", 128 * 1024), ts: "2026-01-01T00:00:01.000Z" }); // > 64 KB cap
    writeFileSync(receiptsPath(), `${JSON.stringify(good1)}\n${monster}\n${JSON.stringify(good2)}\n`);

    const out = await readReceipts();
    expect(out.map((r) => r.task)).toEqual(["good-2", "good-1"]); // monster dropped, neighbours kept
  });
});

function fetchReceiptAt(task: string, i: number, phase: "sent" | "done" = "sent"): FetchReceipt {
  return {
    kind: "fetch",
    ts: `2026-07-13T10:00:00.${String(i).padStart(3, "0")}Z`,
    host: "api.deskhand.test",
    task,
    bytesSent: i,
    bytesReceived: 0,
    ok: true,
    phase,
  };
}

// Reads the current log's non-empty lines RAW — deliberately not through readReceipts,
// which tolerates (skips) a corrupt line and would hide an interleave.
function rawLines(): string[] {
  return readFileSync(receiptsPath(), "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
}

describe("append serialization", () => {
  // A1 — no interleave under concurrency: fire many appends across BOTH sinks at once;
  // every line on disk is a complete, parseable receipt and the count is exactly N —
  // nothing dropped, split, or merged by two writers racing the same file.
  it("A1: concurrent model + fetch appends never interleave a line", async () => {
    const N = 200;
    const model = fileReceiptSink();
    const fetchS = fileFetchSink();
    // Promise.resolve normalizes the sinks' `void | Promise<void>` return into a promise.
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < N; i++) {
      jobs.push(
        Promise.resolve(
          i % 2 === 0
            ? model.append({ ...modelReceipt("m" + i), ts: `2026-07-13T10:00:00.${String(i).padStart(3, "0")}Z` })
            : fetchS.append(fetchReceiptAt("f" + i, i)),
        ),
      );
    }
    await Promise.all(jobs);

    const lines = rawLines();
    expect(lines).toHaveLength(N);
    // JSON.parse throws (failing the test) on any interleaved/half line; a well-formed
    // receipt always carries a string `ts`, so this is a complete-line assertion.
    for (const line of lines) {
      const obj = JSON.parse(line) as Record<string, unknown>;
      expect(obj["ts"]).toBeTypeOf("string");
    }
  });

  // A2 — FIFO per writer: appends issued in order land in that order on disk (a
  // writer's `sent` precedes its `done`), even when issued without awaiting between.
  it("A2: preserves per-writer order (sent before done)", async () => {
    const sink = fileFetchSink();
    const p1 = sink.append(fetchReceiptAt("ordered", 0, "sent"));
    const p2 = sink.append(fetchReceiptAt("ordered", 1, "done"));
    await Promise.all([p1, p2]);

    const phases = rawLines().map((l) => (JSON.parse(l) as FetchReceipt).phase);
    expect(phases).toEqual(["sent", "done"]);
  });

  // A3 — fail-closed + chain survives: an append whose write fails rejects ITS OWN
  // caller (so the router/receiptedFetch keep egress fail-closed), and a later append
  // still lands — one failure doesn't wedge the single-writer queue.
  it("A3: a failing append rejects its caller but doesn't wedge the queue", async () => {
    const model = fileReceiptSink();
    await model.append({ ...modelReceipt("ok-before"), ts: "2026-07-13T12:00:00.000Z" });

    // Point userData at a non-existent dir so `open` throws (ENOENT) for the next
    // append only; the queue is idle (we awaited ok-before), so only "doomed" runs here.
    const goodDir = state.dir;
    state.dir = path.join(goodDir, "nope-does-not-exist");
    await expect(
      model.append({ ...modelReceipt("doomed"), ts: "2026-07-13T12:00:01.000Z" }),
    ).rejects.toThrow(/ENOENT/); // open() into a missing dir fails closed
    state.dir = goodDir;

    await expect(
      model.append({ ...modelReceipt("ok-after"), ts: "2026-07-13T12:00:02.000Z" }),
    ).resolves.toBeUndefined();

    const tasks = (await readReceipts()).map((r) => r.task);
    expect(tasks).toContain("ok-before");
    expect(tasks).toContain("ok-after");
    expect(tasks).not.toContain("doomed"); // its write never landed
  });

  // A4 — durable: after a model append resolves, the line is on disk (fsync'd via the
  // shared write path — closes the model-vs-fetch durability asymmetry).
  it("A4: a resolved model append is on disk", async () => {
    await fileReceiptSink().append({ ...modelReceipt("durable"), ts: "2026-07-13T13:00:00.000Z" });
    expect(readFileSync(receiptsPath(), "utf8")).toContain("durable");
  });
});

describe("durable activity index", () => {
  // The index bump runs fire-and-forget after a `done` line lands. Because ALL writes
  // share one FIFO queue, awaiting a later throwaway append guarantees prior bumps ran.
  const flush = (): Promise<void> =>
    Promise.resolve(fileReceiptSink().append({ ...modelReceipt("flush"), phase: "sent", ts: "2000-01-01T00:00:00.000Z" }));

  // I1 — a done append bumps its UTC day's bucket; a sent append does not. (bump only
  // increments an already-valid index, so seed one at 0.)
  it("I1: a done receipt bumps its day; sent does not", async () => {
    writeFileSync(activityPath(), JSON.stringify({ "2026-07-14": 0 }));
    await fileReceiptSink().append({ ...modelReceipt("a"), phase: "done", ts: "2026-07-14T10:00:00.000Z" });
    await fileReceiptSink().append({ ...modelReceipt("b"), phase: "done", ts: "2026-07-14T20:00:00.000Z" });
    await fileReceiptSink().append({ ...modelReceipt("c"), phase: "sent", ts: "2026-07-14T21:00:00.000Z" });
    await flush();
    expect(await readActivityIndex()).toEqual({ "2026-07-14": 2 });
  });

  // I2 — the index is a SEPARATE file that log rotation never touches: a pre-rotation
  // day's count survives a rotation, and a new done still bumps.
  it("I2: index survives log rotation (separate file)", async () => {
    writeFileSync(activityPath(), JSON.stringify({ "2025-12-31": 7 }));
    writeFileSync(receiptsPath(), JSON.stringify({ ...modelReceipt("before", MAX_BYTES), ts: "2026-01-01T00:00:00.000Z" }) + "\n");
    await fileReceiptSink().append({ ...modelReceipt("after"), phase: "done", ts: "2026-01-02T00:00:00.000Z" });
    await flush();
    const idx = await readActivityIndex();
    expect(idx["2025-12-31"]).toBe(7); // untouched by the rotation the `after` append triggered
    expect(idx["2026-01-02"]).toBe(1); // and the new done still bumped
    expect(archiveFiles()).toHaveLength(1); // the log DID rotate to an archive
  });

  // I3 — missing index rebuilds from the WHOLE log (archives + live), counting done only.
  it("I3: rebuilds from the whole log when the index is missing", async () => {
    writeFileSync(
      archivePath("receipts.20260101T000000Z.jsonl"),
      JSON.stringify({ ...modelReceipt("x"), phase: "done", ts: "2026-01-01T05:00:00.000Z" }) + "\n",
    );
    writeFileSync(
      receiptsPath(),
      [
        JSON.stringify({ ...modelReceipt("y"), phase: "done", ts: "2026-01-02T05:00:00.000Z" }),
        JSON.stringify({ ...modelReceipt("z"), phase: "sent", ts: "2026-01-02T06:00:00.000Z" }),
      ].join("\n") + "\n",
    );
    expect(existsSync(activityPath())).toBe(false);
    expect(await readActivityIndex()).toEqual({ "2026-01-01": 1, "2026-01-02": 1 });
    expect(existsSync(activityPath())).toBe(true); // the rebuild persisted the cache
  });

  // I4 — a corrupt index self-heals by rebuilding (never degrades to empty).
  it("I4: rebuilds when the index file is corrupt", async () => {
    writeFileSync(activityPath(), "{ not json");
    writeFileSync(receiptsPath(), JSON.stringify({ ...modelReceipt("q"), phase: "done", ts: "2026-03-03T05:00:00.000Z" }) + "\n");
    expect(await readActivityIndex()).toEqual({ "2026-03-03": 1 });
  });

  // I5 — empty/missing log and index → empty map, never throws.
  it("I5: empty everything → {}", async () => {
    expect(await readActivityIndex()).toEqual({});
  });
});

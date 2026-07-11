import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchReceipt, FetchSink } from "@deskhand/core";

// Mock Electron: a controllable userData dir so receiptsFile() points at a temp
// file. safeStorage is unused here but stubbed so the import resolves.
const state = { dir: "" };

vi.mock("electron", () => ({
  app: { getPath: () => state.dir },
}));

import { readReceipts, receiptedFetch } from "./receipts.js";

function receiptsPath(): string {
  return path.join(state.dir, "receipts.jsonl");
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

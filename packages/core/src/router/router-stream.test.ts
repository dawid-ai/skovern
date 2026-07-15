import { describe, expect, it, vi } from "vitest";
import { createRouter } from "./router.js";
import type { Provider, ProviderId, Receipt, ReceiptSink } from "./types.js";

// Loop 030 (Loop A): the router's STREAMING path. Deltas arrive in order and assemble;
// exactly one receipt per message (never one per token); fail-closed egress and the
// local-vs-cloud receipt semantics carry over unchanged from `generate`.

function arraySink(): ReceiptSink & { receipts: Receipt[] } {
  const receipts: Receipt[] = [];
  return { receipts, append: (r) => void receipts.push(r) };
}
const FIXED = (): Date => new Date("2026-07-15T10:00:00.000Z");

// A fake STREAMING provider: emits `deltas` one at a time, checking the abort signal at
// the top of each step (so a caller can stop it from inside onDelta), and resolving with
// the partial actually emitted. `errorAfter` throws mid-stream; `tokens` returns counts.
function streamer(opts: {
  id?: ProviderId;
  onMachine?: boolean;
  deltas: string[];
  tokens?: { tokensIn?: number; tokensOut?: number };
  errorAfter?: number;
}): Provider {
  const id = opts.id ?? "openrouter";
  return {
    id,
    model: `${id}-model`,
    ...(opts.onMachine ? { onMachine: true } : {}),
    generate: vi.fn(async () => opts.deltas.join("")), // fallback; unused when generateStream is present
    generateStream: vi.fn(async (_prompt: string, onDelta: (d: string) => void, signal?: AbortSignal) => {
      let i = 0;
      for (const d of opts.deltas) {
        if (signal?.aborted) break; // top-of-step abort check → stop, resolve partial
        if (opts.errorAfter !== undefined && i === opts.errorAfter) throw new Error("sk-secret mid-stream boom");
        onDelta(d);
        i++;
      }
      const text = opts.deltas.slice(0, i).join("");
      return opts.tokens ? { text, ...opts.tokens } : text;
    }),
  };
}

function router(provider: Provider, sink: ReceiptSink) {
  return createRouter({ providers: { [provider.id]: provider }, defaultProvider: provider.id, sink, now: FIXED });
}

describe("router streaming (Loop A)", () => {
  // S1 — deltas arrive IN ORDER and the resolved text is their concatenation.
  it("S1: forwards deltas in order and assembles the full reply", async () => {
    const sink = arraySink();
    const got: string[] = [];
    const res = await router(streamer({ deltas: ["Hel", "lo", " there"] }), sink).generateStream(
      { task: "chat", prompt: "hi" },
      (d) => got.push(d),
    );
    expect(got).toEqual(["Hel", "lo", " there"]); // order preserved
    expect(res.text).toBe("Hello there"); // assembled from the deltas
  });

  // S2 — exactly ONE receipt per message regardless of delta count (not one per token).
  it("S2: writes exactly one sent + one done, never one per delta", async () => {
    const sink = arraySink();
    await router(streamer({ deltas: ["a", "b", "c", "d", "e"] }), sink).generateStream({ task: "chat", prompt: "hi" }, () => {});
    expect(sink.receipts.map((r) => r.phase)).toEqual(["sent", "done"]);
  });

  // S3 — FAIL-CLOSED: a sink that throws on the "sent" line makes the streamed call reject
  // and produce NO deltas — a byte can't leave without a durable record.
  it("S3: a throwing sink rejects the stream and emits no deltas (fail-closed)", async () => {
    const provider = streamer({ deltas: ["x", "y"] });
    const got: string[] = [];
    const r = createRouter({
      providers: { [provider.id]: provider },
      defaultProvider: provider.id,
      sink: { append: () => { throw new Error("disk full"); } },
      now: FIXED,
    });
    await expect(r.generateStream({ task: "chat", prompt: "hi" }, (d) => got.push(d))).rejects.toThrow(/disk full/);
    expect(got).toEqual([]); // nothing streamed
    expect(provider.generateStream).not.toHaveBeenCalled(); // the byte never left
  });

  // S3-order — the "sent" receipt is recorded BEFORE the first delta leaves.
  it("S3-order: the sent receipt lands before the first delta", async () => {
    const events: string[] = [];
    const provider = streamer({ deltas: ["one", "two"] });
    const r = createRouter({
      providers: { [provider.id]: provider },
      defaultProvider: provider.id,
      sink: { append: (rec) => void events.push(`receipt:${rec.phase}`) },
      now: FIXED,
    });
    await r.generateStream({ task: "chat", prompt: "hi" }, () => events.push("delta"));
    expect(events[0]).toBe("receipt:sent"); // sent is first, before any delta
    expect(events.indexOf("receipt:sent")).toBeLessThan(events.indexOf("delta"));
  });

  // S4 — a LOCAL (on-machine) streamed call is recorded on-machine (local:true) with its
  // token counts — never as cloud egress.
  it("S4: a local stream is receipted local:true with token counts", async () => {
    const sink = arraySink();
    const { receipt } = await router(
      streamer({ id: "local", onMachine: true, deltas: ["priv", "ate"], tokens: { tokensIn: 7, tokensOut: 42 } }),
      sink,
    ).generateStream({ task: "chat", prompt: "hi" }, () => {});
    expect(sink.receipts.every((r) => r.local === true)).toBe(true); // both sent + done on-machine
    expect(receipt).toMatchObject({ phase: "done", local: true, tokensIn: 7, tokensOut: 42 });
  });

  // S5 — STOP mid-stream: aborting after the first delta resolves with the PARTIAL text
  // and still writes a done receipt (ok:true — a user stop is not a failure); no hang.
  it("S5: stop after the first delta → partial text + done receipt, resolves", async () => {
    const sink = arraySink();
    const controller = new AbortController();
    const got: string[] = [];
    const res = await router(streamer({ deltas: ["keep", "DROP", "DROP2"] }), sink).generateStream(
      { task: "chat", prompt: "hi" },
      (d) => {
        got.push(d);
        if (got.length === 1) controller.abort(); // stop right after the first token
      },
      controller.signal,
    );
    expect(got).toEqual(["keep"]); // only the first delta streamed
    expect(res.text).toBe("keep"); // partial returned
    const done = sink.receipts.at(-1)!;
    expect(done).toMatchObject({ phase: "done", ok: true }); // recorded, not a failure
    expect(done.bytesReceived).toBe(4); // "keep"
  });

  // S6 — a bad on-machine token count is OMITTED on the streaming path too (trust boundary).
  it("S6: a non-integer/negative token count is omitted, never stamped", async () => {
    const sink = arraySink();
    const { receipt } = await router(
      streamer({ id: "local", onMachine: true, deltas: ["hi"], tokens: { tokensIn: 3.5, tokensOut: -2 } }),
      sink,
    ).generateStream({ task: "chat", prompt: "hi" }, () => {});
    expect(receipt.tokensIn).toBeUndefined();
    expect(receipt.tokensOut).toBeUndefined();
    expect(JSON.stringify(sink.receipts)).not.toContain("3.5");
  });

  // S7 — a mid-stream provider error rejects cleanly with a GENERIC message, writes a
  // done(ok:false) receipt, and never leaks the provider's error detail.
  it("S7: a mid-stream error → generic reject + done(ok:false), no leak", async () => {
    const sink = arraySink();
    const got: string[] = [];
    const r = router(streamer({ deltas: ["safe", "then"], errorAfter: 1 }), sink);
    await expect(r.generateStream({ task: "chat", prompt: "hi" }, (d) => got.push(d))).rejects.toThrow(/brain "openrouter" failed/);
    await expect(r.generateStream({ task: "chat", prompt: "hi" }, () => {})).rejects.not.toThrow(/sk-secret/);
    expect(got).toEqual(["safe"]); // the pre-error delta streamed
    expect(sink.receipts.at(-1)).toMatchObject({ phase: "done", ok: false });
  });

  // S8 — a provider WITHOUT generateStream still works via the fallback: the whole reply
  // arrives as a single delta, one receipt pair.
  it("S8: a non-streaming provider falls back to one whole-reply delta", async () => {
    const sink = arraySink();
    const got: string[] = [];
    const plain: Provider = { id: "anthropic", model: "m", generate: async () => "whole reply" };
    const res = await router(plain, sink).generateStream({ task: "chat", prompt: "hi" }, (d) => got.push(d));
    expect(got).toEqual(["whole reply"]); // one delta
    expect(res.text).toBe("whole reply");
    expect(sink.receipts.map((r) => r.phase)).toEqual(["sent", "done"]);
  });
});

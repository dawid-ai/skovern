import { describe, expect, it, vi } from "vitest";
import { createRouter } from "./router.js";
import type { Provider, Receipt, ReceiptSink } from "./types.js";

function fakeProvider(id: Provider["id"], reply: string | Error): Provider {
  return {
    id,
    model: `${id}-model`,
    generate: vi.fn(async () => {
      if (reply instanceof Error) throw reply;
      return reply;
    }),
  };
}

function arraySink(): ReceiptSink & { receipts: Receipt[] } {
  const receipts: Receipt[] = [];
  return { receipts, append: (r) => void receipts.push(r) };
}

const FIXED = () => new Date("2026-07-10T17:00:00.000Z");

describe("model router", () => {
  it("routes to the default brain and to a named one", async () => {
    const sink = arraySink();
    const router = createRouter({
      providers: {
        openrouter: fakeProvider("openrouter", "via openrouter"),
        anthropic: fakeProvider("anthropic", "via anthropic"),
      },
      defaultProvider: "openrouter",
      sink,
      now: FIXED,
    });

    expect((await router.generate({ task: "t", prompt: "hi" })).text).toBe("via openrouter");
    expect(
      (await router.generate({ task: "t", prompt: "hi", provider: "anthropic" })).text,
    ).toBe("via anthropic");
    // one "done" receipt each, routed to the right brain
    expect(sink.receipts.filter((r) => r.phase === "done").map((r) => r.provider)).toEqual([
      "openrouter",
      "anthropic",
    ]);
  });

  it("records the egress BEFORE the send (fail-closed), then finalizes the outcome", async () => {
    const sink = arraySink();
    const router = createRouter({
      providers: { openrouter: fakeProvider("openrouter", "pong") },
      defaultProvider: "openrouter",
      sink,
      now: FIXED,
    });

    const secretPrompt = "my private business plan";
    const { receipt } = await router.generate({ task: "Test my brain", prompt: secretPrompt });

    // exactly two lines: "sent" (before egress) then "done" (outcome)
    expect(sink.receipts.map((r) => r.phase)).toEqual(["sent", "done"]);
    const [sent, done] = sink.receipts;
    expect(sent).toEqual({
      ts: "2026-07-10T17:00:00.000Z",
      provider: "openrouter",
      model: "openrouter-model",
      task: "Test my brain",
      bytesSent: secretPrompt.length,
      bytesReceived: 0,
      ok: false,
      phase: "sent",
    });
    expect(done).toEqual({ ...sent, bytesReceived: 4, ok: true, phase: "done" });
    expect(receipt).toEqual(done);
    // No prompt/response body, no key, anywhere in the log.
    const dump = JSON.stringify(sink.receipts);
    expect(dump).not.toContain(secretPrompt);
    expect(dump).not.toContain("pong");
  });

  it("is fail-closed: the pre-egress receipt gates the send — sink throws → provider never called", async () => {
    const provider = fakeProvider("openrouter", "leaked-answer");
    const router = createRouter({
      providers: { openrouter: provider },
      defaultProvider: "openrouter",
      sink: {
        append: () => {
          throw new Error("disk full");
        },
      },
      now: FIXED,
    });

    await expect(router.generate({ task: "t", prompt: "hi" })).rejects.toThrow(/disk full/);
    // the byte never left: the provider was not called
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("records a failed attempt (done ok:false) and throws a generic error", async () => {
    const sink = arraySink();
    const router = createRouter({
      providers: { openrouter: fakeProvider("openrouter", new Error("sk-secret-key leaked!")) },
      defaultProvider: "openrouter",
      sink,
      now: FIXED,
    });

    await expect(router.generate({ task: "t", prompt: "hi" })).rejects.toThrow(/brain "openrouter" failed/);
    expect(sink.receipts.map((r) => r.phase)).toEqual(["sent", "done"]);
    expect(sink.receipts.at(-1)!.ok).toBe(false);
    // the provider's error (which named a key) never reaches the caller
    await expect(router.generate({ task: "t", prompt: "hi" })).rejects.not.toThrow(/sk-secret/);
  });

  it("stamps a valid on-machine token count, but never a non-integer one (trust boundary)", async () => {
    // A good on-machine provider: integer counts land on the receipt.
    const good = arraySink();
    const goodLocal: Provider = { id: "local", model: "m", onMachine: true, generate: async () => ({ text: "hi", tokensIn: 7, tokensOut: 42 }) };
    const { receipt: goodReceipt } = await createRouter({ providers: { local: goodLocal }, defaultProvider: "local", sink: good, now: FIXED }).generate({ task: "t", prompt: "hi" });
    expect(goodReceipt.tokensIn).toBe(7);
    expect(goodReceipt.tokensOut).toBe(42);

    // A misbehaving on-machine provider returning a non-integer / negative count: the
    // receipt OMITS the count (never a fabricated/garbage value), it doesn't throw.
    const bad = arraySink();
    const badLocal: Provider = { id: "local", model: "m", onMachine: true, generate: async () => ({ text: "hi", tokensIn: 3.5, tokensOut: -2 }) };
    const { receipt: badReceipt } = await createRouter({ providers: { local: badLocal }, defaultProvider: "local", sink: bad, now: FIXED }).generate({ task: "t", prompt: "hi" });
    expect(badReceipt.tokensIn).toBeUndefined();
    expect(badReceipt.tokensOut).toBeUndefined();
    expect(JSON.stringify(bad.receipts)).not.toContain("3.5");
  });

  it("refuses to construct without a sink or a configured default", () => {
    const sink = arraySink();
    // @ts-expect-error — proving the runtime guard, not just the type
    expect(() => createRouter({ providers: {}, defaultProvider: "openrouter" })).toThrow(/sink/);
    expect(() =>
      createRouter({ providers: {}, defaultProvider: "openrouter", sink }),
    ).toThrow(/not configured/);
  });
});

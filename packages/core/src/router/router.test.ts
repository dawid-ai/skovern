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
    expect(sink.receipts.map((r) => r.provider)).toEqual(["openrouter", "anthropic"]);
  });

  it("writes exactly one receipt per call, metadata only", async () => {
    const sink = arraySink();
    const router = createRouter({
      providers: { openrouter: fakeProvider("openrouter", "pong") },
      defaultProvider: "openrouter",
      sink,
      now: FIXED,
    });

    const secretPrompt = "my private business plan";
    const { receipt } = await router.generate({ task: "Test my brain", prompt: secretPrompt });

    expect(sink.receipts).toHaveLength(1);
    expect(receipt).toEqual({
      ts: "2026-07-10T17:00:00.000Z",
      provider: "openrouter",
      model: "openrouter-model",
      task: "Test my brain",
      bytesSent: secretPrompt.length,
      bytesReceived: 4,
      ok: true,
    });
    // No prompt/response body, no key, anywhere in the receipt.
    const dump = JSON.stringify(receipt);
    expect(dump).not.toContain(secretPrompt);
    expect(dump).not.toContain("pong");
  });

  it("records a failed attempt (ok:false) and throws a generic error", async () => {
    const sink = arraySink();
    const router = createRouter({
      providers: { openrouter: fakeProvider("openrouter", new Error("sk-secret-key leaked!")) },
      defaultProvider: "openrouter",
      sink,
      now: FIXED,
    });

    await expect(router.generate({ task: "t", prompt: "hi" })).rejects.toThrow(/brain "openrouter" failed/);
    expect(sink.receipts).toHaveLength(1);
    expect(sink.receipts[0]!.ok).toBe(false);
    // the provider's error (which named a key) never reaches the caller
    await expect(router.generate({ task: "t", prompt: "hi" })).rejects.not.toThrow(/sk-secret/);
  });

  it("is fail-closed: a sink that throws rejects the call, no text returned", async () => {
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

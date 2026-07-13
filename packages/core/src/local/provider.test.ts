import { describe, expect, it } from "vitest";
import { localProvider } from "./provider.js";
import { createRouter } from "../router/router.js";
import type { LocalEngine, LocalGenerateResult, LocalModelInfo } from "./types.js";
import type { Receipt, ReceiptSink } from "../router/types.js";

// R1 — no false egress. A `local` generate must be recorded as ON-MACHINE
// (`local: true`), not as a network "sent" like a cloud brain. The router copies
// the provider's on-machine flag onto every receipt for the call.

function fakeEngine(reply: string | Error | LocalGenerateResult): LocalEngine {
  return {
    detect: () => Promise.resolve(true),
    listModels: (): Promise<LocalModelInfo[]> => Promise.resolve([]),
    generate: () =>
      reply instanceof Error
        ? Promise.reject(reply)
        : Promise.resolve(typeof reply === "string" ? { text: reply } : reply),
    pull: () => Promise.resolve(),
  };
}

function arraySink(): ReceiptSink & { receipts: Receipt[] } {
  const receipts: Receipt[] = [];
  return { receipts, append: (r) => void receipts.push(r) };
}

describe("localProvider through the router (R1)", () => {
  it("exposes the on-machine flag and its model id", () => {
    const p = localProvider(fakeEngine("hi"), "qwen2.5:3b");
    expect(p.id).toBe("local");
    expect(p.model).toBe("qwen2.5:3b");
    expect(p.onMachine).toBe(true);
  });

  it("records a local generate as on-machine (local:true), NOT egress", async () => {
    const sink = arraySink();
    const router = createRouter({
      providers: { local: localProvider(fakeEngine("A private answer that never left."), "qwen2.5:3b") },
      defaultProvider: "local",
      sink,
    });

    const { text, receipt } = await router.generate({ task: "Run a skill", prompt: "my private prompt" });
    expect(text).toBe("A private answer that never left.");

    // Both the "sent" and "done" receipts carry local:true.
    expect(sink.receipts).toHaveLength(2);
    for (const r of sink.receipts) {
      expect(r.local).toBe(true);
      expect(r.provider).toBe("local");
    }
    expect(receipt.local).toBe(true);
    // Still metadata-only — no prompt or answer body in the log.
    const dump = JSON.stringify(sink.receipts);
    expect(dump).not.toContain("my private prompt");
    expect(dump).not.toContain("never left");
  });

  it("copies the engine's token counts onto the local (done) receipt", async () => {
    const sink = arraySink();
    const router = createRouter({
      providers: { local: localProvider(fakeEngine({ text: "hi", tokensIn: 12, tokensOut: 34 }), "qwen2.5:3b") },
      defaultProvider: "local",
      sink,
    });
    const { receipt } = await router.generate({ task: "t", prompt: "hi" });
    expect(receipt.tokensIn).toBe(12);
    expect(receipt.tokensOut).toBe(34);
    // The "sent" receipt (before the answer) has no counts yet; the "done" one does.
    expect(sink.receipts[0]!.tokensOut).toBeUndefined();
    expect(sink.receipts[1]!.tokensOut).toBe(34);
  });

  it("a local call that reports NO tokens leaves the fields undefined (never 0/NaN)", async () => {
    const sink = arraySink();
    const router = createRouter({
      providers: { local: localProvider(fakeEngine({ text: "hi" }), "qwen2.5:3b") },
      defaultProvider: "local",
      sink,
    });
    const { receipt } = await router.generate({ task: "t", prompt: "hi" });
    expect(receipt.tokensIn).toBeUndefined();
    expect(receipt.tokensOut).toBeUndefined();
    expect("tokensOut" in receipt).toBe(false);
  });

  it("a cloud provider is NOT marked local and gets NO token fields (no regression)", async () => {
    const sink = arraySink();
    const router = createRouter({
      providers: {
        // Even if a cloud provider returned counts, they're not on-machine → not copied.
        openrouter: { id: "openrouter", model: "gpt", generate: () => Promise.resolve({ text: "cloud", tokensIn: 9, tokensOut: 9 }) },
      },
      defaultProvider: "openrouter",
      sink,
    });
    await router.generate({ task: "t", prompt: "hi" });
    for (const r of sink.receipts) {
      expect(r.local).toBeUndefined();
      expect(r.tokensIn).toBeUndefined();
      expect(r.tokensOut).toBeUndefined();
    }
  });

  it("a failing engine rejects with the engine's message, never crashes", async () => {
    const p = localProvider(fakeEngine(new Error("Ollama isn't running on this computer")), "qwen2.5:3b");
    await expect(p.generate("hi")).rejects.toThrow(/Ollama isn't running/);
  });
});

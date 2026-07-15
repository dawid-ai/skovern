import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchSink, GgufSource } from "@deskhand/core";

// Mock the downloader so the engine test needs neither electron nor a real file: which
// models count as "downloaded" is controlled here.
const downloaded = new Set<string>();
vi.mock("./download.js", () => ({
  modelDownloaded: (f: string) => downloaded.has(f),
  modelPath: (f: string) => "/models/" + f,
}));

import { llamaEngine, type ChildLike, type EmbeddedModel, type FromChild, type ToChild } from "./llama-engine.js";

const noopSink: FetchSink = { append: () => {} };

function gguf(filename: string): GgufSource {
  return { url: "https://h.test/m.gguf", sha256: "0".repeat(64), sizeBytes: 10, filename, contextSize: 4096 };
}

// A controllable fake child: captures sends, lets the test drive ready/result/error/exit.
class Fake implements ChildLike {
  sent: ToChild[] = [];
  private msg: ((m: FromChild) => void)[] = [];
  private exitCbs: ((c: number | null) => void)[] = [];
  private errCbs: ((e: Error) => void)[] = [];
  killed = false;
  constructor(private onGenerate?: (m: ToChild, f: Fake) => void) {}
  send(m: ToChild): void {
    this.sent.push(m);
    this.onGenerate?.(m, this);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- match ChildLike's overloaded on()
  on(event: any, cb: any): void {
    if (event === "message") this.msg.push(cb);
    else if (event === "exit") this.exitCbs.push(cb);
    else if (event === "error") this.errCbs.push(cb);
  }
  kill(): void {
    this.killed = true;
  }
  emit(m: FromChild): void {
    this.msg.forEach((cb) => cb(m));
  }
  exit(): void {
    this.exitCbs.forEach((cb) => cb(0));
  }
  error(e: Error): void {
    this.errCbs.forEach((cb) => cb(e));
  }
}

function models(): EmbeddedModel[] {
  return [{ id: "qwen", label: "Qwen", gguf: gguf("qwen.gguf") }];
}

afterEach(() => {
  downloaded.clear();
  vi.restoreAllMocks();
});

describe("llamaEngine over a fake child", () => {
  // L1 — happy path: generate sends the prompt and parses the child's reply + tokens.
  it("L1: generate returns the child's text and token counts", async () => {
    downloaded.add("qwen.gguf");
    const fake = new Fake((m, f) => f.emit({ type: "result", id: m.id, text: "hi there", tokensIn: 3, tokensOut: 5 }));
    const engine = llamaEngine({ models, fetchSink: noopSink, spawn: () => fake });
    const p = engine.generate("qwen", "hello");
    fake.emit({ type: "ready" }); // unblock ensureReady → engine sends the generate
    await expect(p).resolves.toEqual({ text: "hi there", tokensIn: 3, tokensOut: 5 });
    expect(fake.sent[0]).toMatchObject({ type: "generate", prompt: "hello", modelPath: "/models/qwen.gguf", contextSize: 4096 });
  });

  // L2 — a per-request child error becomes a descriptive rejection (never a host throw).
  it("L2: a child 'error' message rejects that generate with the reason", async () => {
    downloaded.add("qwen.gguf");
    const fake = new Fake((m, f) => f.emit({ type: "error", id: m.id, message: "out of memory" }));
    const engine = llamaEngine({ models, fetchSink: noopSink, spawn: () => fake });
    const p = engine.generate("qwen", "hi");
    fake.emit({ type: "ready" });
    await expect(p).rejects.toThrow(/out of memory/);
  });

  // L3 — the child dies BEFORE reporting ready (native load failed): detect() is false and
  // generate rejects descriptively — an honest "not available", never a crash.
  it("L3: a child that exits before ready → detect false, generate rejects", async () => {
    downloaded.add("qwen.gguf");
    const fake = new Fake();
    const engine = llamaEngine({ models, fetchSink: noopSink, spawn: () => fake });
    const detectP = engine.detect();
    fake.exit(); // dies before "ready"
    await expect(detectP).resolves.toBe(false);
  });

  // L3b — an explicit load-error → detect false.
  it("L3b: a load-error message → detect false", async () => {
    const fake = new Fake();
    const engine = llamaEngine({ models, fetchSink: noopSink, spawn: () => fake });
    const detectP = engine.detect();
    fake.emit({ type: "load-error", message: "no binary for this platform" });
    await expect(detectP).resolves.toBe(false);
  });

  // L4 — the child crashes MID-request (after ready): the in-flight generate rejects, the
  // queue isn't wedged, and the host never sees an uncaught throw.
  it("L4: a child exit mid-request rejects the pending generate", async () => {
    downloaded.add("qwen.gguf");
    const fake = new Fake(); // never answers — we crash it instead
    const engine = llamaEngine({ models, fetchSink: noopSink, spawn: () => fake });
    const p = engine.generate("qwen", "hi");
    fake.emit({ type: "ready" });
    await Promise.resolve(); // let the engine send the generate
    fake.exit(); // crash after the request is in flight
    await expect(p).rejects.toThrow(/stopped unexpectedly|isn't available/i);
  });

  // L5 — guardrails: an unknown model, and a known-but-not-downloaded model, reject with
  // specific reasons (never spawn/generate against a missing file).
  it("L5: unknown model and not-downloaded model reject descriptively", async () => {
    const engine = llamaEngine({ models, fetchSink: noopSink, spawn: () => new Fake() });
    await expect(engine.generate("mystery", "hi")).rejects.toThrow(/can run on its own/i);
    // qwen is known but NOT in the downloaded set
    await expect(engine.generate("qwen", "hi")).rejects.toThrow(/Download this model first/i);
  });

  // L6 — a silent child (no reply) trips the generate timeout → descriptive rejection.
  it("L6: a non-answering child times out with a descriptive reason", async () => {
    downloaded.add("qwen.gguf");
    const fake = new Fake(); // receives the generate but never replies
    const engine = llamaEngine({ models, fetchSink: noopSink, spawn: () => fake, genTimeoutMs: 20 });
    const p = engine.generate("qwen", "hi");
    fake.emit({ type: "ready" });
    await expect(p).rejects.toThrow(/took too long/i);
  });

  // L7 — listModels reports only embedded models whose file is on disk.
  it("L7: listModels returns only downloaded embedded models", async () => {
    const engine = llamaEngine({ models, fetchSink: noopSink, spawn: () => new Fake() });
    expect(await engine.listModels()).toEqual([]);
    downloaded.add("qwen.gguf");
    expect(await engine.listModels()).toEqual([{ id: "qwen", label: "Qwen", sizeBytes: 10 }]);
  });

  // E1 — generateStream forwards each `chunk` message to onDelta IN ORDER and resolves
  // with the final `result` (text + token counts).
  it("E1: generateStream forwards chunks in order and resolves the final result", async () => {
    downloaded.add("qwen.gguf");
    const fake = new Fake((m, f) => {
      if (m.type !== "generate") return;
      f.emit({ type: "chunk", id: m.id, text: "Hel" });
      f.emit({ type: "chunk", id: m.id, text: "lo" });
      f.emit({ type: "result", id: m.id, text: "Hello", tokensIn: 2, tokensOut: 3 });
    });
    const engine = llamaEngine({ models, fetchSink: noopSink, spawn: () => fake });
    const got: string[] = [];
    const p = engine.generateStream!("qwen", "hi", (d) => got.push(d));
    fake.emit({ type: "ready" }); // unblock ensureReady → engine sends the generate
    await expect(p).resolves.toEqual({ text: "Hello", tokensIn: 2, tokensOut: 3 });
    expect(got).toEqual(["Hel", "lo"]); // deltas in order
  });

  // E2 — aborting mid-stream sends `abort` to the child; the child's partial `result`
  // resolves the call. No hang, no crash.
  it("E2: abort tells the child to stop and resolves with the partial", async () => {
    downloaded.add("qwen.gguf");
    const controller = new AbortController();
    const fake = new Fake((m, f) => {
      if (m.type === "generate") {
        f.emit({ type: "chunk", id: m.id, text: "keep" }); // one token, then we wait for the abort
      } else if (m.type === "abort") {
        f.emit({ type: "result", id: m.id, text: "keep", tokensIn: 1, tokensOut: 1 }); // partial
      }
    });
    const engine = llamaEngine({ models, fetchSink: noopSink, spawn: () => fake });
    const got: string[] = [];
    const p = engine.generateStream!(
      "qwen",
      "hi",
      (d) => {
        got.push(d);
        if (got.length === 1) controller.abort(); // stop right after the first token
      },
      controller.signal,
    );
    fake.emit({ type: "ready" });
    await expect(p).resolves.toEqual({ text: "keep", tokensIn: 1, tokensOut: 1 });
    expect(got).toEqual(["keep"]);
    expect(fake.sent.some((m) => m.type === "abort")).toBe(true); // the engine forwarded the abort
  });

  // E3 — an ALREADY-aborted signal short-circuits: no generation is spawned (no doomed
  // multi-second run), resolves an empty partial.
  it("E3: a pre-aborted signal never spawns a generation", async () => {
    downloaded.add("qwen.gguf");
    const fake = new Fake();
    const engine = llamaEngine({ models, fetchSink: noopSink, spawn: () => fake });
    const controller = new AbortController();
    controller.abort(); // stopped before we even ask
    await expect(engine.generateStream!("qwen", "hi", () => {}, controller.signal)).resolves.toEqual({ text: "" });
    expect(fake.sent.some((m) => m.type === "generate")).toBe(false); // nothing sent to the child
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// receipts.ts (pulled in transitively) imports electron for app.getPath — stub it.
vi.mock("electron", () => ({ app: { isPackaged: false, getPath: () => "." } }));
// The embedded model's file must read as "downloaded" so generate() proceeds to the child.
vi.mock("./download.js", () => ({
  modelDownloaded: () => true,
  modelPath: (f: string) => `/models/${f}`,
}));

import { llamaEngine, type ChildLike, type EmbeddedModel, type FromChild, type ToChild } from "./llama-engine.js";

// Loop 034 — the embedded runtime's idle-unload: the correct, activity-based replacement for
// the old "wipe the model when the window hides" (which killed a brain mid-job). The timer
// only runs while warm AND idle, so a running generation is never interrupted (U3); any use
// resets it (U2); 5 min unused frees the child (U1). isWarm() drives the green/gray chip.

const MODELS: EmbeddedModel[] = [
  { id: "m", label: "M", gguf: { filename: "m.gguf", url: "https://x/m.gguf", sha256: "a".repeat(64), sizeBytes: 1, contextSize: 2048 } },
];

// A controllable fake child: reports "ready" on the next tick, and answers a "generate"
// with a "result" only when the test calls finish(). kill() is spied so we can see a reap.
function makeFakeChild(): { child: ChildLike; ready: () => void; finish: (id: number) => void; killed: () => number; sent: ToChild[] } {
  const listeners: { message: ((m: FromChild) => void)[]; exit: ((c: number | null) => void)[]; error: ((e: Error) => void)[] } = { message: [], exit: [], error: [] };
  const sent: ToChild[] = [];
  let kills = 0;
  const emit = (m: FromChild): void => listeners.message.forEach((cb) => cb(m));
  return {
    sent,
    killed: () => kills,
    ready: () => emit({ type: "ready" }),
    finish: (id: number) => emit({ type: "result", id, text: "hi", tokensIn: 1, tokensOut: 1 }),
    child: {
      send: (msg: ToChild) => sent.push(msg),
      on: (event, cb) => {
        if (event === "message") listeners.message.push(cb as (m: FromChild) => void);
        else if (event === "exit") listeners.exit.push(cb as (c: number | null) => void);
        else if (event === "error") listeners.error.push(cb as (e: Error) => void);
      },
      kill: () => {
        kills++;
      },
    },
  };
}

const IDLE = 1000;

describe("embedded idle-unload", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // Drive one full generate to completion so the engine is warm and idle.
  async function warmup(): Promise<{ engine: ReturnType<typeof llamaEngine>; fakes: ReturnType<typeof makeFakeChild>[] }> {
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const engine = llamaEngine({
      models: () => MODELS,
      fetchSink: { append: () => {} },
      idleMs: IDLE,
      spawn: () => {
        const f = makeFakeChild();
        fakes.push(f);
        queueMicrotask(f.ready); // report ready right after spawn
        return f.child;
      },
    });
    const p = engine.generate("m", "hi");
    await vi.advanceTimersByTimeAsync(0); // let ready fire + the generate send
    fakes[fakes.length - 1]!.finish(1);
    await p;
    return { engine, fakes };
  }

  it("U1: frees the warm child after IDLE_MS of no use", async () => {
    const { engine, fakes } = await warmup();
    expect(engine.isWarm()).toBe(true);
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(fakes[0]!.killed()).toBe(1); // reaped
    expect(engine.isWarm()).toBe(false); // chip goes gray
  });

  it("U2: a use just before expiry RESETS the timer — stays warm", async () => {
    const { engine, fakes } = await warmup();
    await vi.advanceTimersByTimeAsync(IDLE - 1); // almost expired…
    const p = engine.generate("m", "again"); // …but a use resets it
    await vi.advanceTimersByTimeAsync(0);
    fakes[0]!.finish(2);
    await p;
    await vi.advanceTimersByTimeAsync(IDLE - 1); // past the ORIGINAL deadline, not the new one
    expect(fakes[0]!.killed()).toBe(0);
    expect(engine.isWarm()).toBe(true);
  });

  it("U3: NEVER kills a generation in flight; the clock only starts once it settles", async () => {
    const { engine, fakes } = await warmup();
    const p = engine.generate("m", "long"); // in flight — no result yet
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(IDLE * 3); // way past idle, but a request is pending
    expect(fakes[0]!.killed()).toBe(0); // not reaped mid-generation
    expect(engine.isWarm()).toBe(true);
    fakes[0]!.finish(2); // now it settles…
    await p;
    await vi.advanceTimersByTimeAsync(IDLE); // …and only now does idle apply
    expect(fakes[0]!.killed()).toBe(1);
  });

  it("U3 (cold start): the FIRST generation after a spawn is never killed mid-flight", async () => {
    // No warmup — a cold engine. The `ready` handler arms idle while pending is momentarily
    // empty; the generate must clear that timer so a slow cold answer isn't reaped. (Regression:
    // before the post-ensureReady cancelIdle, idle fired at ready-time and killed the child.)
    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const engine = llamaEngine({
      models: () => MODELS,
      fetchSink: { append: () => {} },
      idleMs: IDLE,
      spawn: () => {
        const f = makeFakeChild();
        fakes.push(f);
        queueMicrotask(f.ready);
        return f.child;
      },
    });
    const p = engine.generate("m", "long"); // cold, kept in flight
    await vi.advanceTimersByTimeAsync(0); // ready fires (armed idle at ready-time before the fix)
    await vi.advanceTimersByTimeAsync(IDLE * 2); // long past idle while the request is pending
    expect(fakes[0]!.killed()).toBe(0); // NOT reaped mid-generation
    expect(engine.isWarm()).toBe(true);
    fakes[0]!.finish(1);
    await p;
  });

  it("respawns on the next use after an idle-unload", async () => {
    const { engine, fakes } = await warmup();
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(fakes).toHaveLength(1);
    const p = engine.generate("m", "wake up");
    await vi.advanceTimersByTimeAsync(0);
    fakes[fakes.length - 1]!.finish(2);
    await p;
    expect(fakes).toHaveLength(2); // a fresh child was spawned
    expect(engine.isWarm()).toBe(true);
  });

  // Loop 041 — manual "Free memory": unload() reclaims VRAM on demand (like idle, but now), and
  // the model respawns on next use. It REFUSES while a reply is in flight so nothing is yanked.
  it("U4: unload() frees the warm child on demand; the next generate respawns", async () => {
    const { engine, fakes } = await warmup();
    expect(engine.isWarm()).toBe(true);
    expect(engine.unload()).toBe(true); // freed
    expect(fakes[0]!.killed()).toBe(1);
    expect(engine.isWarm()).toBe(false);
    const p = engine.generate("m", "again"); // respawns
    await vi.advanceTimersByTimeAsync(0);
    fakes[fakes.length - 1]!.finish(2);
    await p;
    expect(fakes).toHaveLength(2);
    expect(engine.isWarm()).toBe(true);
  });

  it("U4: unload() REFUSES while a reply is in flight — never yanks the model mid-answer", async () => {
    const { engine, fakes } = await warmup();
    const p = engine.generate("m", "long"); // in flight
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.unload()).toBe(false); // refused
    expect(fakes[0]!.killed()).toBe(0);
    expect(engine.isWarm()).toBe(true);
    fakes[0]!.finish(2); // settle so nothing hangs
    await p;
  });
});

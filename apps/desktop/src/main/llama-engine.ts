import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchSink, GgufSource, LocalEngine, LocalGenerateResult, LocalModelInfo, PullProgress } from "@deskhand/core";
import { downloadModel, modelDownloaded, modelPath } from "./download.js";

// The EMBEDDED Local Brain backend (Loop 2a): runs a downloaded GGUF via node-llama-cpp
// in a FORKED CHILD. The child, not main, loads the native runtime — because a native
// LLM crash (a segfault in llama.cpp) is NOT catchable by a JS try/catch and, in-process,
// would take down all of Electron main (the exact class we hotfixed for claude-cli). A
// child contains it, and EVERY failure — spawn, load, inference, silence, abnormal exit —
// becomes a specific, plain-language REJECTION, never an async throw that crashes the host.
//
// CI never spawns the real child: the `spawn` seam is injected with a fake, so the native
// addon is loaded only during hand-validation on a real machine.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_GEN_TIMEOUT_MS = 180_000; // a small model on CPU can be slow; generous
const READY_TIMEOUT_MS = 30_000;

const NO_MODEL = "That's not a model this computer can run on its own yet.";
const NOT_DOWNLOADED = "Download this model first, then use it.";
const RUNTIME_DOWN = "The private brain runtime isn't available on this computer yet.";
const CRASHED = "The private brain stopped unexpectedly. Try again.";
const TOO_SLOW = "The private brain took too long to answer and was stopped.";

// The parent → child wire protocol.
export type ToChild = { type: "generate"; id: number; modelPath: string; prompt: string; contextSize: number };
// The child → parent protocol.
export type FromChild =
  | { type: "ready" }
  | { type: "load-error"; message: string }
  | { type: "result"; id: number; text: string; tokensIn?: number; tokensOut?: number }
  | { type: "error"; id: number; message: string };

// The minimal child surface the engine drives — a real forked ChildProcess, or a fake
// in tests. Kept tiny so a fake is trivial and the engine never leans on Node internals.
export interface ChildLike {
  send(msg: ToChild): void;
  on(event: "message", cb: (m: FromChild) => void): void;
  on(event: "exit", cb: (code: number | null) => void): void;
  on(event: "error", cb: (e: Error) => void): void;
  kill(): void;
}

/** One embedded model the engine can run: its id/label + where to fetch it. */
export interface EmbeddedModel {
  id: string;
  label: string;
  gguf: GgufSource;
}

export interface LlamaEngineOptions {
  /** The embedded catalog models (those with a `gguf` block). */
  models: () => EmbeddedModel[];
  /** Receipt sink for the download egress. */
  fetchSink: FetchSink;
  /** Spawn the runtime child. Injected in tests (a fake); defaults to forking llama-child. */
  spawn?: () => ChildLike;
  /** Injected download fetch (tests point it at a fixture server). */
  fetchImpl?: typeof fetch;
  genTimeoutMs?: number;
}

// Re-fork the Electron binary as plain Node (ELECTRON_RUN_AS_NODE), same mechanism as
// the plugin host. The child (llama-child.js, a separate build output) dynamically imports
// node-llama-cpp (an optional dep) and loads the native runtime there, never in main.
function forkChild(): ChildLike {
  const child = fork(path.join(__dirname, "llama-child.js"), [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  return child as unknown as ChildLike;
}

export function llamaEngine(opts: LlamaEngineOptions): LocalEngine & { dispose(): void } {
  const spawn = opts.spawn ?? forkChild;
  const genTimeoutMs = opts.genTimeoutMs ?? DEFAULT_GEN_TIMEOUT_MS;

  let child: ChildLike | null = null;
  let readyPromise: Promise<void> | null = null;
  let nextId = 1;
  const pending = new Map<number, { resolve: (r: LocalGenerateResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  function lookup(modelId: string): GgufSource | undefined {
    return opts.models().find((m) => m.id === modelId)?.gguf;
  }

  // Fail every in-flight request and drop the child so the next call respawns. Called on
  // any child death — a crash can never leave a caller hanging or crash the host.
  function teardown(reason: string): void {
    child = null;
    readyPromise = null;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    pending.clear();
  }

  // Spawn + wait for the child to report the native runtime loaded. Cached: one warm
  // child for the engine's life.
  function ensureReady(): Promise<void> {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise<void>((resolve, reject) => {
      let c: ChildLike;
      try {
        c = spawn();
      } catch (e) {
        reject(e instanceof Error ? e : new Error(RUNTIME_DOWN));
        return;
      }
      child = c;
      const readyTimer = setTimeout(() => teardownReject(new Error(RUNTIME_DOWN)), READY_TIMEOUT_MS);
      let settled = false;
      function teardownReject(err: Error): void {
        if (!settled) {
          settled = true;
          clearTimeout(readyTimer);
        }
        teardown(err.message);
        reject(err);
      }
      c.on("message", (m: FromChild) => {
        if (m.type === "ready") {
          if (settled) return;
          settled = true;
          clearTimeout(readyTimer);
          resolve();
        } else if (m.type === "load-error") {
          teardownReject(new Error(m.message || RUNTIME_DOWN));
        } else if (m.type === "result") {
          const p = pending.get(m.id);
          if (p) {
            pending.delete(m.id);
            clearTimeout(p.timer);
            p.resolve({ text: m.text, tokensIn: m.tokensIn, tokensOut: m.tokensOut });
          }
        } else if (m.type === "error") {
          const p = pending.get(m.id);
          if (p) {
            pending.delete(m.id);
            clearTimeout(p.timer);
            p.reject(new Error(m.message || CRASHED));
          }
        }
      });
      // A child that dies (segfault, OOM, killed) fires exit/error — reject readiness if
      // still pending, and fail every in-flight generate. Never an uncaught throw.
      c.on("exit", () => {
        if (!settled) teardownReject(new Error(RUNTIME_DOWN));
        else teardown(CRASHED);
      });
      c.on("error", (e: Error) => {
        if (!settled) teardownReject(e instanceof Error ? new Error(RUNTIME_DOWN) : new Error(RUNTIME_DOWN));
        else teardown(CRASHED);
      });
    });
    return readyPromise;
  }

  return {
    async detect(): Promise<boolean> {
      try {
        await ensureReady();
        return true;
      } catch {
        return false; // native runtime not available here → honest "not yet", never a crash
      }
    },

    async listModels(): Promise<LocalModelInfo[]> {
      // The embedded models whose file is on disk (verified at download time).
      return opts
        .models()
        .filter((m) => modelDownloaded(m.gguf.filename))
        .map((m): LocalModelInfo => ({ id: m.id, label: m.label, sizeBytes: m.gguf.sizeBytes }));
    },

    async generate(modelId: string, prompt: string): Promise<LocalGenerateResult> {
      const gguf = lookup(modelId);
      if (!gguf) throw new Error(NO_MODEL);
      if (!modelDownloaded(gguf.filename)) throw new Error(NOT_DOWNLOADED);
      await ensureReady();
      const c = child;
      if (!c) throw new Error(RUNTIME_DOWN);
      const id = nextId++;
      return new Promise<LocalGenerateResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(TOO_SLOW));
        }, genTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          c.send({ type: "generate", id, modelPath: modelPath(gguf.filename), prompt, contextSize: gguf.contextSize });
        } catch {
          pending.delete(id);
          clearTimeout(timer);
          reject(new Error(CRASHED));
        }
      });
    },

    pull(modelId: string, onProgress?: (p: PullProgress) => void): Promise<void> {
      const gguf = lookup(modelId);
      if (!gguf) return Promise.reject(new Error(NO_MODEL));
      return downloadModel(
        gguf,
        opts.fetchSink,
        (p) => onProgress?.({ status: "downloading", completed: p.completed, total: p.total, percent: p.percent }),
        opts.fetchImpl,
      ).then(() => undefined);
    },

    dispose(): void {
      const c = child;
      teardown(CRASHED);
      try {
        c?.kill();
      } catch {
        /* already gone */
      }
    },
  };
}

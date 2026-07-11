import { spawn, type ChildProcess } from "node:child_process";
import type { Provider } from "@deskhand/core";

// A brain backed by the local Claude Code CLI (`claude -p`). It runs on the user's
// existing subscription at ZERO api cost — no key, no keychain. Spawned from the
// TRUSTED main process (the sandboxed skill child never spawns anything); the prompt
// is written to STDIN, never a command line, and the process runs WITHOUT a shell —
// so nothing in the prompt (which may carry prior model output) is ever interpreted
// as a command. The router still wraps this in a fail-closed egress receipt.

export interface ClaudeCliOptions {
  /** Executable to run. Defaults to "claude" (resolved on PATH; `claude.exe` on
   *  Windows). Injected so the packaging policy + dev/test seam live in the caller. */
  bin?: string;
  /** Leading args before `-p` — the ONLY use is pointing at an interpreter wrapper
   *  (e.g. `[node, stub.mjs]`) in dev/test. Trusted caller-set; never user input.
   *  Production leaves it empty (the real `claude` is directly spawnable). */
  baseArgs?: string[];
  /** Optional `--model`; omitted → the CLI's own default. */
  model?: string;
  /** Hard per-call cap; the child is killed if it overruns. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * Drain a spawned child's stdout to a resolved string, turning EVERY failure mode
 * into a rejection — never an async throw. This is the crash fix: an unhandled
 * `'error'` on the stdout/stderr STREAM (which a `claude` that dies mid-pipe under
 * rapid calls can emit) would otherwise propagate as an uncaught exception and, in
 * the Electron main process, take the whole app down (exit 1). Every listener here
 * funnels through the single-shot `settle` guard.
 */
export function collectOutput(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;
    function settle(done: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done();
    }
    const timer = setTimeout(() => {
      settle(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        reject(new Error("claude-cli timed out"));
      });
    }, timeoutMs);

    child.on("error", (e) => settle(() => reject(e))); // ENOENT (no CLI) lands here
    // A broken pipe (child dies mid-stream) emits 'error' on these streams — handle
    // it, or the uncaught event crashes the host process.
    child.stdout?.on("error", (e) => settle(() => reject(e)));
    child.stderr?.on("error", (e) => settle(() => reject(e)));
    child.stdout?.on("data", (d: Buffer) => outChunks.push(d));
    child.stderr?.on("data", (d: Buffer) => errChunks.push(d));
    child.on("close", (code) =>
      settle(() => {
        const text = Buffer.concat(outChunks).toString("utf8").trim();
        if (code !== 0) {
          const err = Buffer.concat(errChunks).toString("utf8").trim().slice(0, 200);
          return reject(new Error(`claude-cli exited ${code ?? "abnormally"}: ${err}`));
        }
        if (!text) return reject(new Error("claude-cli returned nothing"));
        resolve(text);
      }),
    );
  });
}

export function claudeCliProvider(opts: ClaudeCliOptions = {}): Provider {
  const bin = opts.bin ?? "claude";
  const model = opts.model?.trim();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    id: "claude-cli",
    // A label for the receipt only; the CLI picks the real model unless --model is set.
    model: model || "claude-code",
    generate(prompt: string): Promise<string> {
      const args = [...(opts.baseArgs ?? []), "-p", ...(model ? ["--model", model] : [])];
      // shell:false (the default) is load-bearing security — do not enable it.
      const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
      const result = collectOutput(child, timeoutMs);
      // The prompt goes on stdin — never argv, never a shell. Swallow EPIPE if the
      // child died early; `collectOutput` reports the real reason.
      child.stdin?.on("error", () => {});
      child.stdin?.end(prompt);
      return result;
    },
  };
}

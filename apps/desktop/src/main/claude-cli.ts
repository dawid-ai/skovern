import { spawn } from "node:child_process";
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

export function claudeCliProvider(opts: ClaudeCliOptions = {}): Provider {
  const bin = opts.bin ?? "claude";
  const model = opts.model?.trim();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    id: "claude-cli",
    // A label for the receipt only; the CLI picks the real model unless --model is set.
    model: model || "claude-code",
    generate(prompt: string): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        const args = [...(opts.baseArgs ?? []), "-p", ...(model ? ["--model", model] : [])];
        // shell:false (the default) is load-bearing security — do not enable it.
        const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
        // Collect raw bytes and decode once — a multibyte char split across two
        // chunks would corrupt if we decoded per-chunk.
        const outChunks: Buffer[] = [];
        const errChunks: Buffer[] = [];
        let settled = false;

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

        function settle(done: () => void): void {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          done();
        }

        child.on("error", (e) => settle(() => reject(e))); // ENOENT (no CLI) lands here
        child.stdout.on("data", (d: Buffer) => outChunks.push(d));
        child.stderr.on("data", (d: Buffer) => errChunks.push(d));
        child.on("close", (code) =>
          settle(() => {
            const text = Buffer.concat(outChunks).toString("utf8").trim();
            if (code !== 0) {
              const err = Buffer.concat(errChunks).toString("utf8").trim().slice(0, 200);
              return reject(new Error(`claude-cli exited ${code}: ${err}`));
            }
            if (!text) return reject(new Error("claude-cli returned nothing"));
            resolve(text);
          }),
        );

        // The prompt goes on stdin — never argv, never a shell.
        child.stdin.on("error", () => {}); // EPIPE if the child died early; `close` reports the real reason
        child.stdin.end(prompt);
      });
    },
  };
}

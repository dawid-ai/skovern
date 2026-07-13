import type { LocalEngine, LocalGenerateResult, LocalModelInfo, PullProgress } from "./types.js";

// The Ollama backend for the Local Brain. It talks to Ollama's HTTP API on
// loopback ONLY — the privacy guarantee: "local" can never be pointed at a remote
// host to exfiltrate a prompt. Every failure becomes a specific, plain-language
// REJECTION (never a bare throw), so a dead/absent Ollama surfaces a message a
// non-technical user (or support) can act on — and never crashes the host.
//
// Timeouts cover the WHOLE operation, not just connecting (mirror claude-cli's
// collectOutput, whose timer bounds the entire read): a server that returns 200
// headers then stalls the body is bounded, and a `pull` whose stream goes silent
// trips an IDLE timeout (reset on every progress chunk) so a healthy multi-GB
// download never trips while a truly stalled one still fails fast.

export interface OllamaOptions {
  /** Base URL of the Ollama server. MUST be loopback; anything else is refused. */
  baseUrl: string;
  /** Injected fetch for tests (a fixture server). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Hard per-call cap (connect + full body read) for non-streaming calls. */
  timeoutMs?: number;
  /** Idle cap for a streamed pull: if NO progress chunk arrives for this long, the
   *  download is treated as stalled. A steadily-progressing pull never trips it. */
  pullIdleMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
// A healthy pull emits progress frequently; a minute of total silence means stalled.
const DEFAULT_PULL_IDLE_MS = 60_000;

const TOO_SLOW = "The local brain took too long to answer and was stopped.";
const PULL_STALLED = "The download stalled — check your connection and try again.";

// Loopback = this machine only. Accept the three names that always resolve to it;
// reject everything else (including any DNS name that could resolve off-box).
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isAbort(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}

function assertLoopback(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`The local brain address "${baseUrl}" isn't a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`The local brain must use http on this computer, not "${url.protocol}".`);
  }
  // `hostname` strips the port and any [] on IPv6, so compare both forms.
  const host = url.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `The local brain can only talk to this computer (127.0.0.1), not "${url.hostname}". ` +
        "That's how we keep it private.",
    );
  }
  return url;
}

// A friendly reason for a fetch that never connected (Ollama not running is the
// overwhelmingly common case), vs one that answered with an error status.
function notRunning(cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `Ollama isn't running on this computer — start it and try again. (${detail.slice(0, 120)})`,
  );
}

/** Build an Ollama-backed `LocalEngine`. Throws immediately if `baseUrl` isn't
 *  loopback — the guard is at construction so an off-box URL can never be used. */
export function ollamaEngine(opts: OllamaOptions): LocalEngine {
  const base = assertLoopback(opts.baseUrl);
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pullIdleMs = opts.pullIdleMs ?? DEFAULT_PULL_IDLE_MS;
  const origin = base.origin;

  // Fetch AND read the whole JSON body under ONE deadline. The AbortController
  // stays armed until the body is fully parsed, so a server that sends headers then
  // stalls the body is bounded (the abort rejects `res.json()`), not hung. Every
  // failure path is a specific rejection.
  async function getJson(path: string, init: RequestInit | undefined, what: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res: Response;
      try {
        res = await doFetch(`${origin}${path}`, { ...init, signal: controller.signal });
      } catch (cause) {
        throw isAbort(cause) ? new Error(TOO_SLOW) : notRunning(cause);
      }
      if (!res.ok) {
        throw new Error(`Ollama answered with an error (${res.status}) while ${what}.`);
      }
      try {
        return await res.json();
      } catch (cause) {
        // An abort during the body read lands here — report the timeout, not a
        // generic parse error.
        if (isAbort(cause) || controller.signal.aborted) throw new Error(TOO_SLOW);
        throw new Error(`Ollama sent back something we couldn't read while ${what}.`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async detect(): Promise<boolean> {
      // A yes/no probe: reachable + answering on /api/tags. Any failure = "no".
      try {
        await getJson("/api/tags", undefined, "checking");
        return true;
      } catch {
        return false;
      }
    },

    async listModels(): Promise<LocalModelInfo[]> {
      const body = await getJson("/api/tags", undefined, "listing your models");
      const models = (body as { models?: unknown }).models;
      if (!Array.isArray(models)) {
        throw new Error("Ollama's model list came back in a shape we didn't expect.");
      }
      return models.map((raw): LocalModelInfo => {
        const m = (raw ?? {}) as Record<string, unknown>;
        const id = typeof m["name"] === "string" ? m["name"] : typeof m["model"] === "string" ? (m["model"] as string) : "";
        const details = (m["details"] ?? {}) as Record<string, unknown>;
        const sizeBytes = typeof m["size"] === "number" ? m["size"] : undefined;
        const quant = typeof details["quantization_level"] === "string" ? (details["quantization_level"] as string) : undefined;
        const paramStr = typeof details["parameter_size"] === "string" ? (details["parameter_size"] as string) : undefined;
        const params = paramStr ? parseParamSize(paramStr) : undefined;
        return { id, label: id, params, sizeBytes, quant };
      }).filter((m) => m.id.length > 0);
    },

    async generate(modelId: string, prompt: string): Promise<LocalGenerateResult> {
      const body = await getJson(
        "/api/generate",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          // stream:false → one JSON object with the whole reply.
          body: JSON.stringify({ model: modelId, prompt, stream: false }),
        },
        "thinking",
      );
      const obj = (body ?? {}) as Record<string, unknown>;
      const text = obj["response"];
      if (typeof text !== "string" || text.length === 0) {
        throw new Error("The local brain answered with nothing — try a different model.");
      }
      // Ollama reports token usage as prompt_eval_count (in) / eval_count (out).
      // Absent on older Ollama / some models → undefined, never faked to 0.
      return { text, tokensIn: countOf(obj["prompt_eval_count"]), tokensOut: countOf(obj["eval_count"]) };
    },

    async pull(modelId: string, onProgress?: (p: PullProgress) => void): Promise<void> {
      // Idle timer: a healthy pull resets it on every chunk; total silence past
      // pullIdleMs aborts as "stalled" (a fixed total cap would wrongly kill a big,
      // steadily-downloading model).
      const controller = new AbortController();
      let stalled = false;
      // undefined until first armed; clearTimeout(undefined) is a safe no-op. Typed
      // this way because TS can't see the assignment happens inside the `arm` closure.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          stalled = true;
          controller.abort();
        }, pullIdleMs);
      };
      arm();

      try {
        let res: Response;
        try {
          res = await doFetch(`${origin}/api/pull`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: modelId, stream: true }),
            signal: controller.signal,
          });
        } catch (cause) {
          throw stalled || isAbort(cause) ? new Error(PULL_STALLED) : notRunning(cause);
        }
        if (!res.ok) {
          throw new Error(`Ollama couldn't start the download (${res.status}). Check the model name.`);
        }
        if (!res.body) {
          throw new Error("Ollama didn't send any download progress — try again.");
        }
        try {
          // `arm` resets the idle timer each time a chunk arrives.
          await consumePull(res.body, onProgress, arm);
        } catch (cause) {
          // A stall abort surfaces here as an AbortError; report it plainly.
          if (stalled || isAbort(cause)) throw new Error(PULL_STALLED);
          throw cause; // handlePullLine's error (bad model, disk full…) is already descriptive
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// A token count from Ollama, if it's a finite non-negative number; undefined
// otherwise (missing field, or a garbage value we won't show as a real count).
function countOf(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

// "3.2B", "1.5B", "500M" → billions of params. Best-effort; undefined if unparseable.
function parseParamSize(s: string): number | undefined {
  const match = /([\d.]+)\s*([bBmM])/.exec(s.trim());
  if (!match) return undefined;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return undefined;
  return match[2]!.toLowerCase() === "m" ? n / 1000 : n;
}

// Ollama's /api/pull streams newline-delimited JSON objects. Parse each complete
// line, forward progress, and reject on the first error line (a bad model name,
// disk full…) with its message so the user sees the real reason. `onChunk` fires
// on every received chunk so the caller can reset its idle/stall timer.
async function consumePull(
  body: ReadableStream<Uint8Array>,
  onProgress?: (p: PullProgress) => void,
  onChunk?: () => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        onChunk?.();
        buffer += decoder.decode(value, { stream: true });
      }
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.length > 0) handlePullLine(line, onProgress);
      }
      if (done) break;
    }
    const tail = buffer.trim();
    if (tail.length > 0) handlePullLine(tail, onProgress);
  } finally {
    reader.releaseLock();
  }
}

function handlePullLine(line: string, onProgress?: (p: PullProgress) => void): void {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return; // skip a partial/garbled line rather than fail the whole pull
  }
  if (typeof obj["error"] === "string") {
    throw new Error(`Ollama couldn't get that model: ${(obj["error"] as string).slice(0, 160)}`);
  }
  const status = typeof obj["status"] === "string" ? (obj["status"] as string) : "downloading";
  const completed = typeof obj["completed"] === "number" ? (obj["completed"] as number) : undefined;
  const total = typeof obj["total"] === "number" ? (obj["total"] as number) : undefined;
  const percent =
    completed !== undefined && total !== undefined && total > 0
      ? Math.max(0, Math.min(100, Math.round((completed / total) * 100)))
      : undefined;
  onProgress?.({ status, completed, total, percent });
}

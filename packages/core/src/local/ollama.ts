import type { LocalEngine, LocalModelInfo, PullProgress } from "./types.js";

// The Ollama backend for the Local Brain. It talks to Ollama's HTTP API on
// loopback ONLY — the privacy guarantee: "local" can never be pointed at a remote
// host to exfiltrate a prompt. Every failure becomes a specific, plain-language
// REJECTION (never a bare throw), so a dead/absent Ollama surfaces a message a
// non-technical user (or support) can act on — and never crashes the host.

export interface OllamaOptions {
  /** Base URL of the Ollama server. MUST be loopback; anything else is refused. */
  baseUrl: string;
  /** Injected fetch for tests (a fixture server). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Hard per-call cap so a hung generate/pull can't wedge forever. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

// Loopback = this machine only. Accept the three names that always resolve to it;
// reject everything else (including any DNS name that could resolve off-box).
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

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
  const origin = base.origin;

  // One fetch with a timeout that always rejects with a clear cause. `signal`
  // aborts a hung request so a wedged Ollama can't block forever.
  async function call(path: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(`${origin}${path}`, { ...init, signal: controller.signal });
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") {
        throw new Error("The local brain took too long to answer and was stopped.");
      }
      throw notRunning(cause);
    } finally {
      clearTimeout(timer);
    }
  }

  async function readJson(res: Response, what: string): Promise<unknown> {
    if (!res.ok) {
      throw new Error(`Ollama answered with an error (${res.status}) while ${what}.`);
    }
    try {
      return await res.json();
    } catch {
      throw new Error(`Ollama sent back something we couldn't read while ${what}.`);
    }
  }

  return {
    async detect(): Promise<boolean> {
      try {
        const res = await call("/api/tags");
        return res.ok;
      } catch {
        // detect is a yes/no probe — a failure just means "not reachable".
        return false;
      }
    },

    async listModels(): Promise<LocalModelInfo[]> {
      const res = await call("/api/tags");
      const body = await readJson(res, "listing your models");
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

    async generate(modelId: string, prompt: string): Promise<string> {
      const res = await call("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // stream:false → one JSON object with the whole reply.
        body: JSON.stringify({ model: modelId, prompt, stream: false }),
      });
      const body = await readJson(res, "thinking");
      const text = (body as { response?: unknown }).response;
      if (typeof text !== "string" || text.length === 0) {
        throw new Error("The local brain answered with nothing — try a different model.");
      }
      return text;
    },

    async pull(modelId: string, onProgress?: (p: PullProgress) => void): Promise<void> {
      const res = await call("/api/pull", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: modelId, stream: true }),
      });
      if (!res.ok) {
        throw new Error(`Ollama couldn't start the download (${res.status}). Check the model name.`);
      }
      if (!res.body) {
        throw new Error("Ollama didn't send any download progress — try again.");
      }
      await consumePull(res.body, onProgress);
    },
  };
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
// disk full…) with its message so the user sees the real reason.
async function consumePull(
  body: ReadableStream<Uint8Array>,
  onProgress?: (p: PullProgress) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
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

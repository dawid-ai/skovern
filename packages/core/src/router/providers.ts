import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import type { Provider } from "./types.js";

// Real brains, AI SDK-backed. These are the ONLY code that holds an API key:
// each closes over its key so neither the router nor a receipt ever sees it.
// Imported by the desktop main process — never by the renderer.

export interface ProviderOptions {
  apiKey: string;
  /** Override the model id; each provider ships a sensible default. */
  model?: string;
  /** Override the API base (self-hosted proxy, or a test double). https only. */
  baseURL?: string;
}

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

// Security note (contract §): provider calls are https only. A base URL override
// exists for self-hosted proxies + tests, but it may not downgrade a real egress
// to plaintext — only https, or a loopback host (the dev/test mock), is allowed.
function assertSafeBaseUrl(baseURL: string): void {
  const u = new URL(baseURL);
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
  if (u.protocol !== "https:" && !loopback) {
    throw new Error("brain base URL must be https");
  }
}

/** OpenRouter — one key, every model. It's OpenAI-compatible, so we drive it
 *  through the OpenAI adapter pointed at OpenRouter's base URL. */
export function openRouterProvider(opts: ProviderOptions): Provider {
  const model = opts.model ?? "anthropic/claude-3.5-haiku";
  if (opts.baseURL) assertSafeBaseUrl(opts.baseURL);
  const openrouter = createOpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL ?? OPENROUTER_BASE,
  });
  return {
    id: "openrouter",
    model,
    async generate(prompt: string): Promise<string> {
      // .chat() forces the Chat Completions API — OpenRouter's compatible shape,
      // not OpenAI's newer Responses API.
      const { text } = await generateText({ model: openrouter.chat(model), prompt });
      return text;
    },
  };
}

/** Anthropic — a native BYO key, to prove the router isn't single-provider. */
export function anthropicProvider(opts: ProviderOptions): Provider {
  const model = opts.model ?? "claude-3-5-haiku-latest";
  if (opts.baseURL) assertSafeBaseUrl(opts.baseURL);
  const anthropic = createAnthropic({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  });
  return {
    id: "anthropic",
    model,
    async generate(prompt: string): Promise<string> {
      const { text } = await generateText({ model: anthropic(model), prompt });
      return text;
    },
  };
}

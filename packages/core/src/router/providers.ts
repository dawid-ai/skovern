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

/** OpenRouter — one key, every model. It's OpenAI-compatible, so we drive it
 *  through the OpenAI adapter pointed at OpenRouter's base URL. */
export function openRouterProvider(opts: ProviderOptions): Provider {
  const model = opts.model ?? "anthropic/claude-3.5-haiku";
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

// Shapes crossing the renderer ↔ main IPC boundary for the brain picker.
// UI-facing: plain data and warm messages, NEVER the API key.

import type { ProviderId, Receipt } from "@skovern/core";

export type { ProviderId, Receipt };

export interface BrainStatusView {
  configured: boolean;
  provider: ProviderId | null;
  /** The active model id (e.g. "qwen2.5:3b"), when one is set. Never the key. */
  model: string | null;
  /** A downloaded built-in (embedded) model exists on disk — the self-reliant floor is
   *  real, so "use my built-in brain" can actually run something (loop 033 Issue 3). */
  builtinReady: boolean;
  /** The optional Ollama helper is installed (may or may not be running) — lets Chat offer
   *  a "Start Ollama" shortcut when the configured Ollama brain is down (loop 033 Issue 1). */
  ollamaInstalled: boolean;
  /** Is the active LOCAL model resident in memory right now? Drives the sidebar chip: green
   *  when loaded, gray when configured-but-unloaded (loop 034). Always false for a non-local
   *  (online) brain — the load/gray distinction is a local-VRAM concept. */
  modelLoaded: boolean;
}

/** Short, florist-facing name for a brain provider — for the Settings "currently
 *  active" line, which has room for a full phrase. */
export function providerName(id: ProviderId): string {
  switch (id) {
    case "local":
      return "On this computer";
    case "claude-cli":
      return "Claude Code";
    case "anthropic":
      return "Claude (Anthropic)";
    case "openrouter":
      return "OpenRouter";
    default:
      return id;
  }
}

/** Compact provider tag for the tight sidebar chip (e.g. "Local: mistral:7b"). */
export function providerShort(id: ProviderId): string {
  switch (id) {
    case "local":
      return "Local";
    case "claude-cli":
      return "Claude Code";
    case "anthropic":
      return "Anthropic";
    case "openrouter":
      return "OpenRouter";
    default:
      return id;
  }
}

export interface SaveBrainInput {
  provider: ProviderId;
  key: string;
  model?: string;
}

export interface SaveBrainResult {
  ok: boolean;
  message: string;
}

export interface TestBrainResult {
  ok: boolean;
  /** Warm, florist-facing status ("Your brain answered!" / what went wrong). */
  message: string;
  /** The brain's reply, on success — untrusted, render escaped. */
  reply?: string;
  /** The receipt written for this test call, so the user sees what left. */
  receipt?: Receipt;
}

// Shapes crossing the renderer ↔ main IPC boundary for the brain picker.
// UI-facing: plain data and warm messages, NEVER the API key.

import type { ProviderId, Receipt } from "@deskhand/core";

export type { ProviderId, Receipt };

export interface BrainStatusView {
  configured: boolean;
  provider: ProviderId | null;
  /** The active model id (e.g. "qwen2.5:3b"), when one is set. Never the key. */
  model: string | null;
}

/** Short, florist-facing name for a brain provider — for the active-brain readouts
 *  (the sidebar widget + the Settings "currently active" line). */
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

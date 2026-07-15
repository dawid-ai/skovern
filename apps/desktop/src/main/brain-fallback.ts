import type { ProviderId } from "@deskhand/core";

// The self-reliance decision, kept pure so it's unit-testable without electron/the runtime.
// STOPGAP (full version → loop 032): when the configured brain is a local OLLAMA model and
// Ollama isn't reachable, answer with a downloaded built-in embedded model instead of
// failing. Every other case uses the configured brain as-is (returns null).

export interface BrainRef {
  provider: ProviderId;
  /** Unused by the decision (kept for call-site ergonomics with the stored brain shape). */
  model?: string | null;
}

/** The embedded model id to fall back to, or null to use the configured brain unchanged.
 *  - not a local brain, or already an embedded local brain → null (no swap)
 *  - a local Ollama brain with Ollama UP → null (use Ollama)
 *  - a local Ollama brain with Ollama DOWN → the downloaded embedded id (or null if none,
 *    so the normal path fails honestly). */
export function pickSelfReliantFallback(
  brain: BrainRef | null,
  isEmbedded: boolean,
  ollamaReady: boolean,
  downloadedEmbeddedId: string | null,
): string | null {
  if (!brain || brain.provider !== "local" || isEmbedded) return null;
  if (ollamaReady) return null;
  return downloadedEmbeddedId;
}

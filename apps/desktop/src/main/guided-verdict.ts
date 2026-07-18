import type { VerdictModel } from "@skovern/core";

// The candidate set the recommendation scores: our BUILT-IN (gguf) catalog ONLY.
//
// Every built-in model is always gettable — we host the file and download it ourselves — so
// the pick is simply "the biggest one that runs great on this computer." That makes it STABLE:
// it never lurches when a background Ollama starts or stops (loop 037). An Ollama-only catalog
// pick and the user's own already-pulled models are deliberately NOT scored here, so neither
// can ever BECOME the recommendation, regardless of whether Ollama is up.
//
// Both `localStatus` (the headline) and `localModels` (the hero) score this SAME set, so the
// two views always name the same model — a single source of truth, no divergence.

const GB = 1024 * 1024 * 1024;

type CandidateInput = { id: string; label: string; params?: number; sizeBytes?: number; gguf?: unknown };

// A catalog model may not state its parameter size; estimate from the file size so the verdict
// can still score it (Q4 ≈ 0.6 GB per billion params).
function toVerdictModel(m: CandidateInput): VerdictModel {
  const params = m.params ?? (m.sizeBytes ? m.sizeBytes / (0.6 * GB) : 3);
  // Built-in models are always fetchable (we download them), so fetchable is unconditionally true.
  return { id: m.id, label: m.label, params, sizeBytes: m.sizeBytes, fetchable: true };
}

/** The built-in-only candidate set for the guided recommendation. A model is built-in when it
 *  carries a `gguf` block (an Ollama-only catalog entry has none) — those are the ones we run
 *  ourselves without any external program. */
export function builtInCandidates(catalogModels: CandidateInput[]): VerdictModel[] {
  return catalogModels.filter((m) => m.gguf !== undefined).map(toVerdictModel);
}

import { verdict, type HardwareProfile, type Verdict, type VerdictModel } from "@skovern/core";
import { fromOllamaRegistry } from "./ollama-name.js";

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

type CandidateInput = { id: string; label: string; params?: number; sizeBytes?: number; quant?: string; gguf?: unknown };

// A catalog model may not state its parameter size; estimate from the file size so the verdict
// can still score it (Q4 ≈ 0.6 GB per billion params). With neither, the 3B placeholder still
// gives it a tier, but it's marked guessed so no made-up speed is ever shown for it (046).
function toVerdictModel(m: CandidateInput): VerdictModel {
  const guessed = m.params === undefined && !m.sizeBytes;
  const params = m.params ?? (m.sizeBytes ? m.sizeBytes / (0.6 * GB) : 3);
  // Built-in models are always fetchable (we download them), so fetchable is unconditionally true.
  return { id: m.id, label: m.label, params, sizeBytes: m.sizeBytes, quant: m.quant, fetchable: true, ...(guessed ? { paramsGuessed: true } : {}) };
}

/** The built-in-only candidate set for the guided recommendation. A model is built-in when it
 *  carries a `gguf` block (an Ollama-only catalog entry has none) — those are the ones we run
 *  ourselves without any external program. */
export function builtInCandidates(catalogModels: CandidateInput[]): VerdictModel[] {
  return catalogModels.filter((m) => m.gguf !== undefined).map(toVerdictModel);
}

/** Every listed model as a scorable `VerdictModel` — built-in AND Ollama (catalog suggestions,
 *  the user's own pulled models). Feeds the DISPLAYED fit tier of each row, so an Ollama model
 *  shows its REAL fit instead of a default amber. The RECOMMENDATION still uses builtInCandidates
 *  only (037 flip-kill), so widening the DISPLAY set can never widen what becomes the pick. */
export function allCandidates(models: CandidateInput[]): VerdictModel[] {
  return models.map(toVerdictModel);
}

/** The catalog brains that run through Ollama (no `gguf` block) and download from Ollama's own
 *  registry — gettable when Skovern can set Ollama up on this computer (loop 047). A catalog id that
 *  names another server never becomes the pick (SEC-047-2). */
export function ollamaPathCandidates(catalogModels: CandidateInput[]): VerdictModel[] {
  return catalogModels.filter((m) => m.gguf === undefined && fromOllamaRegistry(m.id)).map(toVerdictModel);
}

/** THE recommendation (loop 047): one function both the headline (`localStatus`) and the hero
 *  (`localModels`) call, so they always name the same brain.
 *
 *  Inputs are hardware + catalog + whether Skovern can set Ollama up on this KIND of computer —
 *  never whether any Ollama is installed or running — so the pick can't flip (loop 037 holds).
 *  A brain that needs Ollama wins only when it's a GOOD pick and bigger than the best good
 *  built-in: a small or slow computer never gets asked to set up a helper. */
export function guidedVerdict(profile: HardwareProfile, catalogModels: CandidateInput[], canSetUpOllama: boolean): Verdict {
  const builtIns = builtInCandidates(catalogModels);
  const base = verdict(profile, builtIns);
  if (!canSetUpOllama) return base;
  const wide = verdict(profile, [...builtIns, ...ollamaPathCandidates(catalogModels)]);
  if (!wide.canRunGoodOne || wide.recommendedModelId === null) return base;
  if (builtIns.some((m) => m.id === wide.recommendedModelId)) return base;
  const paramsOf = (vs: VerdictModel[], id: string | null) => vs.find((m) => m.id === id)?.params ?? 0;
  const widePick = paramsOf(ollamaPathCandidates(catalogModels), wide.recommendedModelId);
  const basePick = base.canRunGoodOne ? paramsOf(builtIns, base.recommendedModelId) : 0;
  return widePick > basePick ? wide : base;
}

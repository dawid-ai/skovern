import type { LocalModelView } from "../../../shared/local.js";

// Embedded-first split (loop 028): the main list ("here") holds every model that's
// ACTIONABLE right now — embedded models (download + run on the GPU, no Ollama) always,
// plus Ollama models when Ollama is actually running. The "advanced" bucket holds only
// the models that CAN'T be acted on now (Ollama-only, Ollama down) — so they're tucked
// into a collapsed section instead of walling off the main choice. This means: no Ollama
// → the runnable embedded models lead and Ollama models are demoted; Ollama running →
// nothing is hidden (everything's actionable, one list). Pure + order-preserving so the
// view is just rendering (mirrors receipt-classify), unit-tested on its own.
export function partitionModels(
  models: readonly LocalModelView[],
  ollamaReady: boolean,
): { here: LocalModelView[]; advanced: LocalModelView[] } {
  const here: LocalModelView[] = [];
  const advanced: LocalModelView[] = [];
  for (const m of models) {
    const needsOllama = !m.embedded && !ollamaReady; // can't act on it right now
    (needsOllama ? advanced : here).push(m);
  }
  return { here, advanced };
}

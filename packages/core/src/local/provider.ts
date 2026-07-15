import type { Provider } from "../router/types.js";
import type { LocalEngine } from "./types.js";

// A `local` Provider: it wires a LocalEngine into the router as just another
// brain. `onMachine: true` is the load-bearing flag — the router copies it onto
// the receipt as `local: true`, so a local run is recorded as "stayed on your
// computer", never as egress. The engine already turns every failure into a
// descriptive rejection, so this never crashes the host.

export function localProvider(engine: LocalEngine, modelId: string): Provider {
  const provider: Provider = {
    id: "local",
    model: modelId,
    // The whole point: this call never leaves the machine.
    onMachine: true,
    // Hand back the engine's LocalGenerateResult verbatim ({text, tokensIn?,
    // tokensOut?}) — the router copies the token counts onto the local receipt.
    generate(prompt: string): Promise<{ text: string; tokensIn?: number; tokensOut?: number }> {
      return engine.generate(modelId, prompt);
    },
  };
  // Expose streaming only when the engine backs it (the embedded llama runtime does;
  // Ollama doesn't yet, so it falls back to the router's one-delta path). Same token
  // counts, same on-machine receipt — just delivered incrementally.
  if (engine.generateStream) {
    provider.generateStream = (prompt, onDelta, signal) => engine.generateStream!(modelId, prompt, onDelta, signal);
  }
  return provider;
}

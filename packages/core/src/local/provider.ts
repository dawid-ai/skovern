import type { Provider } from "../router/types.js";
import type { LocalEngine } from "./types.js";

// A `local` Provider: it wires a LocalEngine into the router as just another
// brain. `onMachine: true` is the load-bearing flag — the router copies it onto
// the receipt as `local: true`, so a local run is recorded as "stayed on your
// computer", never as egress. The engine already turns every failure into a
// descriptive rejection, so this never crashes the host.

export function localProvider(engine: LocalEngine, modelId: string): Provider {
  return {
    id: "local",
    model: modelId,
    // The whole point: this call never leaves the machine.
    onMachine: true,
    generate(prompt: string): Promise<string> {
      return engine.generate(modelId, prompt);
    },
  };
}

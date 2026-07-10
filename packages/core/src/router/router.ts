import type {
  GenerateInput,
  GenerateResult,
  Provider,
  ProviderId,
  Receipt,
  ReceiptSink,
  Router,
} from "./types.js";

export interface RouterConfig {
  /** The brains available. At least one required. */
  providers: Partial<Record<ProviderId, Provider>>;
  /** Which brain to use when a call doesn't name one. Must be present in `providers`. */
  defaultProvider: ProviderId;
  /** Receipt log. Required — there is no router without a receipt trail. */
  sink: ReceiptSink;
  /** For deterministic timestamps in tests; defaults to the real clock. */
  now?: () => Date;
}

function bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function createRouter(config: RouterConfig): Router {
  const { providers, defaultProvider, sink } = config;
  // Fail-closed at construction: no sink → no router. A missing sink is the one
  // way silent exfil could happen, so it's a hard error, not a default.
  if (!sink || typeof sink.append !== "function") {
    throw new Error("router requires a receipt sink");
  }
  if (!providers[defaultProvider]) {
    throw new Error(`default provider "${defaultProvider}" is not configured`);
  }
  const clock = config.now ?? (() => new Date());

  return {
    async generate(input: GenerateInput): Promise<GenerateResult> {
      const id = input.provider ?? defaultProvider;
      const provider = providers[id];
      if (!provider) throw new Error(`provider "${id}" is not configured`);

      const bytesSent = bytes(input.prompt);
      let text: string | null = null;
      let failed = false;
      try {
        text = await provider.generate(input.prompt);
      } catch {
        // The provider/network error detail stays here — never surfaced to the
        // UI (could carry a key or prompt). Callers get a generic failure.
        failed = true;
      }

      // Always record the attempt — success OR failure. Awaited and NOT
      // swallowed: if the append throws, generate() rejects here, so a caller
      // can never receive model text without a receipt reaching the log first.
      const receipt: Receipt = {
        ts: clock().toISOString(),
        provider: id,
        model: provider.model,
        task: input.task,
        bytesSent,
        bytesReceived: bytes(text ?? ""),
        ok: !failed,
      };
      await sink.append(receipt);

      if (failed || text === null) throw new Error(`brain "${id}" failed`);
      return { text, provider: id, model: provider.model, receipt };
    },
  };
}

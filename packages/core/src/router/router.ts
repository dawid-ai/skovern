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
      const base = { provider: id, model: provider.model, task: input.task, bytesSent };

      // Record the egress BEFORE it happens. This append is awaited and NOT
      // swallowed: if it throws, we reject here and the provider is never
      // called — so a byte cannot leave the machine without a durable receipt.
      await sink.append({ ...base, ts: clock().toISOString(), bytesReceived: 0, ok: false, phase: "sent" });

      let text: string | null = null;
      let failed = false;
      try {
        text = await provider.generate(input.prompt);
      } catch {
        // The provider/network error detail stays here — never surfaced to the
        // UI (could carry a key or prompt). Callers get a generic failure.
        failed = true;
      }

      // Finalize with the outcome. Best-effort: the "sent" receipt already made
      // the egress non-repudiable, so a failed finalize write must not deny the
      // user their answer.
      const receipt: Receipt = {
        ...base,
        ts: clock().toISOString(),
        bytesReceived: bytes(text ?? ""),
        ok: !failed,
        phase: "done",
      };
      try {
        await sink.append(receipt);
      } catch {
        // egress already receipted by the "sent" line
      }

      if (failed || text === null) throw new Error(`brain "${id}" failed`);
      return { text, provider: id, model: provider.model, receipt };
    },
  };
}

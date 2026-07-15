import type {
  GenerateInput,
  GenerateResult,
  Provider,
  ProviderId,
  ProviderOutput,
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

// An on-machine engine reports its own token counts; don't stamp a garbage value onto
// a receipt. Accept only a finite, non-negative integer; anything else → undefined (the
// receipt just omits the count, never shows a fabricated one). Guards a future on-machine
// backend that returns a non-integer — the current engines already sanitize, so this is
// defense-in-depth at the trust boundary (ledger: router-onmachine-token-trust).
function countOf(v: number | undefined): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
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

  // The one call path — streaming or not. `onDelta` receives each chunk (a no-op for the
  // plain `generate`); `signal` can abort a streamed call. Behaviour shared so the receipt
  // rules (one "sent" before egress, one "done" after) are IDENTICAL on both paths.
  async function run(input: GenerateInput, onDelta: (delta: string) => void, signal?: AbortSignal): Promise<GenerateResult> {
    const id = input.provider ?? defaultProvider;
    const provider = providers[id];
    if (!provider) throw new Error(`provider "${id}" is not configured`);

    const bytesSent = bytes(input.prompt);
    // A local provider runs ON the machine — mark every receipt for it `local`
    // so it's recorded as on-machine, never as egress.
    const onMachine = provider.onMachine === true;
    // Only tag `local` when true, so cloud receipts keep their exact prior shape.
    const base = { provider: id, model: provider.model, task: input.task, bytesSent, ...(onMachine ? { local: true } : {}) };

    // Record the egress BEFORE it happens. This append is awaited and NOT
    // swallowed: if it throws, we reject here and the provider is never
    // called — so a byte cannot leave the machine without a durable receipt.
    await sink.append({ ...base, ts: clock().toISOString(), bytesReceived: 0, ok: false, phase: "sent" });

    // The text the USER actually saw is the concatenation of the deltas — the source of
    // truth for the receipt + return value, so an abort yields exactly the partial shown.
    let assembled = "";
    const collect = (delta: string): void => {
      assembled += delta;
      onDelta(delta);
    };

    let out: string | ProviderOutput | undefined;
    let failed = false;
    try {
      if (provider.generateStream) {
        out = await provider.generateStream(input.prompt, collect, signal);
      } else {
        // Non-streaming provider: get the whole reply, emit it as a single delta.
        out = await provider.generate(input.prompt);
        collect(typeof out === "string" ? out : out.text);
      }
    } catch {
      // The provider/network error detail stays here — never surfaced to the UI (could
      // carry a key or prompt). A user-initiated abort is NOT a failure: the bytes that
      // streamed are a legitimate partial answer, so only a real error flips `failed`.
      if (!signal?.aborted) failed = true;
    }

    let tokensIn: number | undefined;
    let tokensOut: number | undefined;
    // Only an on-machine brain's token counts belong on the receipt — a cloud provider
    // returning this shape would still be egress, told in bytes. Re-validate at the trust
    // boundary (countOf) — never stamp a non-integer count.
    if (out !== undefined && typeof out !== "string" && onMachine) {
      tokensIn = countOf(out.tokensIn);
      tokensOut = countOf(out.tokensOut);
    }

    // Finalize with the outcome. Best-effort: the "sent" receipt already made the egress
    // non-repudiable, so a failed finalize write must not deny the user their answer.
    const receipt: Receipt = {
      ...base,
      ts: clock().toISOString(),
      bytesReceived: bytes(assembled),
      ok: !failed,
      phase: "done",
      ...(tokensIn !== undefined ? { tokensIn } : {}),
      ...(tokensOut !== undefined ? { tokensOut } : {}),
    };
    try {
      await sink.append(receipt);
    } catch {
      // egress already receipted by the "sent" line
    }

    if (failed) throw new Error(`brain "${id}" failed`);
    return { text: assembled, provider: id, model: provider.model, receipt };
  }

  return {
    generate(input: GenerateInput): Promise<GenerateResult> {
      return run(input, () => {}, undefined);
    },
    generateStream(input: GenerateInput, onDelta: (delta: string) => void, signal?: AbortSignal): Promise<GenerateResult> {
      return run(input, onDelta, signal);
    },
  };
}

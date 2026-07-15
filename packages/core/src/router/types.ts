// The model router: one door for every brain. A skill asks for text; the router
// picks a provider, gets the text, and — non-negotiably — records a receipt for
// the bytes that left the machine. The renderer never reaches a provider or a
// key directly; it goes UI → core → here.

export type ProviderId = "openrouter" | "anthropic" | "claude-cli" | "local";

/** A single brain the router can call. Adapters (AI SDK-backed) close over the
 *  API key, so the key never reaches the router or a receipt. */
export interface Provider {
  readonly id: ProviderId;
  readonly model: string;
  /** True when this provider runs ON the machine (e.g. a local model): the call
   *  never leaves, so the router marks its receipt `local` instead of egress. */
  readonly onMachine?: boolean;
  /** Send a prompt, get text back — a bare string, or (for a local brain that
   *  reports them) text plus token counts. Throws on a provider/network error. */
  generate(prompt: string): Promise<string | ProviderOutput>;
  /** Streaming variant: emit the reply as ordered deltas via `onDelta`, resolving with
   *  the final text (+ optional token counts). A provider that omits this is driven
   *  through `generate` (the router emits the whole reply as one delta). `signal` aborts
   *  an in-flight stream — the provider should stop and resolve with the partial so far. */
  generateStream?(prompt: string, onDelta: (delta: string) => void, signal?: AbortSignal): Promise<string | ProviderOutput>;
}

/** What a provider hands back. Cloud providers return a bare `string`; a local
 *  (on-machine) engine may return this richer shape so the receipt can show tokens
 *  ("all on your computer") instead of bytes. */
export interface ProviderOutput {
  text: string;
  /** Prompt tokens the model read, if the engine reports them. */
  tokensIn?: number;
  /** Tokens the model generated, if the engine reports them. */
  tokensOut?: number;
}

/** One line in the "what left your machine" log. Metadata only — never the
 *  prompt/response body, never the API key.
 *
 *  Two are written per call: a `"sent"` receipt BEFORE the request leaves (so
 *  egress can't happen without a durable record — fail-closed), then a `"done"`
 *  receipt with the outcome after the reply comes back. */
export interface Receipt {
  /** ISO timestamp. */
  ts: string;
  provider: ProviderId;
  model: string;
  /** Plain-English label for what this call was for ("Test my brain"). */
  task: string;
  bytesSent: number;
  /** 0 on the `"sent"` receipt; the reply size on the `"done"` receipt. */
  bytesReceived: number;
  ok: boolean;
  /** `"sent"` = recorded before egress; `"done"` = the outcome. */
  phase: "sent" | "done";
  /** True when the call ran ON this machine (a local model) and NOTHING left it.
   *  Absent/false for cloud brains. Lets the receipts panel prove "stayed on your
   *  computer" instead of showing a false "sent". */
  local?: boolean;
  /** Prompt/response token counts for an on-machine (local) call, when the engine
   *  reports them. Lets the panel say "X tokens in, Y out — all on your computer"
   *  instead of bytes. Absent for cloud brains, and for a local call that returned
   *  no counts (the panel falls back to the plain "stayed on your computer" line). */
  tokensIn?: number;
  tokensOut?: number;
}

/** Where receipts go. Append-only. Injected, so core stays Electron-agnostic
 *  (desktop appends JSONL to userData; tests collect in an array). */
export interface ReceiptSink {
  append(receipt: Receipt): void | Promise<void>;
}

export interface GenerateInput {
  /** Plain-English label, stored on the receipt. */
  task: string;
  prompt: string;
  /** Override the default brain for this one call. */
  provider?: ProviderId;
}

export interface GenerateResult {
  text: string;
  provider: ProviderId;
  model: string;
  /** The receipt written for this call — so callers can show it immediately. */
  receipt: Receipt;
}

export interface Router {
  generate(input: GenerateInput): Promise<GenerateResult>;
  /** Like `generate`, but streams the reply as ordered deltas via `onDelta`. Writes the
   *  SAME single receipt (a `"sent"` line before egress, one `"done"` after the stream
   *  ends) — never one per delta. `signal` aborts the stream; the returned result then
   *  holds the partial text streamed so far, and the `"done"` receipt is still written. */
  generateStream(input: GenerateInput, onDelta: (delta: string) => void, signal?: AbortSignal): Promise<GenerateResult>;
}

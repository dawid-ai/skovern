// The model router: one door for every brain. A skill asks for text; the router
// picks a provider, gets the text, and — non-negotiably — records a receipt for
// the bytes that left the machine. The renderer never reaches a provider or a
// key directly; it goes UI → core → here.

export type ProviderId = "openrouter" | "anthropic";

/** A single brain the router can call. Adapters (AI SDK-backed) close over the
 *  API key, so the key never reaches the router or a receipt. */
export interface Provider {
  readonly id: ProviderId;
  readonly model: string;
  /** Send a prompt, get text back. Throws on a provider/network error. */
  generate(prompt: string): Promise<string>;
}

/** One line in the "what left your machine" log. Metadata only — never the
 *  prompt/response body, never the API key. */
export interface Receipt {
  /** ISO timestamp. */
  ts: string;
  provider: ProviderId;
  model: string;
  /** Plain-English label for what this call was for ("Test my brain"). */
  task: string;
  bytesSent: number;
  bytesReceived: number;
  ok: boolean;
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
}

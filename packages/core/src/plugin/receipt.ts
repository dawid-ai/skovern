// A plugin's `fetch` egress is still egress — it gets a receipt in the SAME log
// as model calls (loop 011), so "receipts for everything that leaves your
// machine" stays true once skills can reach the network. Distinct shape from the
// model `Receipt`, tagged with `kind:"fetch"` so the future "What leaves your
// machine" panel can tell them apart. Metadata only — host, not the full URL, so
// query-string secrets never land in the log.

export interface FetchReceipt {
  kind: "fetch";
  ts: string;
  /** The host contacted (e.g. "example.com") — never the full URL. */
  host: string;
  /** Plain-English label, e.g. "skill:hello fetch". */
  task: string;
  bytesSent: number;
  bytesReceived: number;
  ok: boolean;
  /** `"sent"` = recorded before egress (fail-closed); `"done"` = the outcome. */
  phase: "sent" | "done";
}

export interface FetchSink {
  append(receipt: FetchReceipt): void | Promise<void>;
}

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
  /** True for the app's own repeating background checks (news/messages/model list)
   *  — set at the call site, so the panel classifies them authoritatively instead of
   *  matching task strings. These still leave the machine and are still logged; the
   *  panel just groups them into a quiet summary rather than a row per poll. Absent
   *  (falsey) for meaningful egress — a brain call, a skill scrape, publishing. */
  routine?: boolean;
  /** Which way the data flowed, from the user's point of view — set at the call site
   *  (authoritative, never sniffed from the task). `"out"` = you sent something out
   *  (a message, a publish); `"in"` = you pulled content in (news, a reply, a website a
   *  skill read). Lets the panel show a plain Out ↑ / In ↓ tag. Absent when it doesn't
   *  apply. */
  direction?: "in" | "out";
}

export interface FetchSink {
  append(receipt: FetchReceipt): void | Promise<void>;
}

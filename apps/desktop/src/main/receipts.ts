import { app } from "electron";
import { appendFileSync } from "node:fs";
import path from "node:path";
import type { Receipt, ReceiptSink } from "@deskhand/core";

// The "what left your machine" log, on disk. One JSON object per line so a future
// panel can tail it. Append is synchronous and unguarded on purpose: if it throws
// (disk full, permissions), the router's call fails — fail-closed, no silent
// egress. Receipts are metadata only; the router never puts a key or body here.

export function receiptsFile(): string {
  return path.join(app.getPath("userData"), "receipts.jsonl");
}

export function fileReceiptSink(): ReceiptSink {
  return {
    append(receipt: Receipt): void {
      appendFileSync(receiptsFile(), JSON.stringify(receipt) + "\n");
    },
  };
}

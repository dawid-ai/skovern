import { app } from "electron";
import { appendFileSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import type { FetchReceipt, FetchSink, Receipt, ReceiptSink } from "@deskhand/core";

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

// A plugin `fetch` is egress too → same log, but DURABLE before it resolves: the
// broker records the "sent" line before any byte leaves, so the receipt must survive
// a crash mid-fetch. appendFileSync buffers in the OS page cache; here we fsync so a
// pulled plug can't lose the one proof that something left the machine.
export function fileFetchSink(): FetchSink {
  return {
    async append(receipt: FetchReceipt): Promise<void> {
      const fh = await open(receiptsFile(), "a");
      try {
        await fh.write(JSON.stringify(receipt) + "\n");
        await fh.sync();
      } finally {
        await fh.close();
      }
    },
  };
}

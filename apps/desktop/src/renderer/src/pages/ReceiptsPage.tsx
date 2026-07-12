import { useEffect, useState } from "react";
import type { ReceiptView } from "../../../shared/receipts.js";

// "What leaves your machine" — the egress log on its own page. Every network call
// that left this computer, newest first, in plain language: what asked, where it
// went, how much, and whether it worked. Read-only; the page can't send anything.

function isFetch(r: ReceiptView): r is Extract<ReceiptView, { kind: "fetch" }> {
  return "kind" in r && r.kind === "fetch";
}

function fmtBytes(n: number): string {
  return n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(1)} KB`;
}

function fmtTime(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const BRAIN_LABEL: Record<string, string> = {
  openrouter: "OpenRouter",
  anthropic: "Claude",
  "claude-cli": "Claude Code",
  local: "your computer",
};

// A local (on-machine) model call — nothing left the machine.
function isLocal(r: ReceiptView): boolean {
  return !isFetch(r) && r.local === true;
}

// Who made the call, in florist words.
function who(r: ReceiptView): string {
  if (!isFetch(r)) return isLocal(r) ? "Your private brain" : "Your brain";
  if (r.task.startsWith("Deskhand:")) return "Deskhand";
  if (r.task.startsWith("skill:")) return "A connector";
  return "A website";
}

// The plain-English reason for the call.
function why(r: ReceiptView): string {
  if (!isFetch(r)) return r.task; // e.g. "Test my brain"
  if (r.task.startsWith("Deskhand:")) return r.task.slice("Deskhand:".length).trim(); // "news", "messages"…
  if (r.task.startsWith("skill:")) return "reading a website for a skill";
  return r.task;
}

// Where it went.
function where(r: ReceiptView): string {
  return isFetch(r) ? r.host : `${BRAIN_LABEL[r.provider] ?? r.provider}`;
}

export function ReceiptsPage() {
  const [receipts, setReceipts] = useState<ReceiptView[] | null>(null);

  useEffect(() => {
    void window.deskhand.receipts.list().then(setReceipts);
  }, []);

  // One row per completed call. The log also holds a "sent" line written before
  // each call leaves (the fail-closed proof) — we show the "done" outcome so the
  // list reads as one line per call, not two.
  const rows = (receipts ?? []).filter((r) => r.phase === "done");

  return (
    <section className="page">
      <header className="page-head">
        <h1>What leaves your machine</h1>
        <p>Every time Deskhand sends something out, it&apos;s written down here. Newest first.</p>
      </header>

      {receipts === null ? (
        <p className="hint">Loading the log…</p>
      ) : rows.length === 0 ? (
        <p className="hint">Nothing has left your machine yet. When it does, you&apos;ll see it here.</p>
      ) : (
        <ul className="receipt-list">
          {rows.map((r, i) => (
            <li key={i} className="receipt-row">
              <div className="receipt-main">
                <span className="receipt-who">{who(r)}</span>
                <span className="receipt-why">{why(r)}</span>
              </div>
              {isLocal(r) ? (
                // A local model call is on-machine — make the privacy claim visible.
                <div className="receipt-meta">
                  <span className="receipt-ok">stayed on your computer — nothing left</span>
                  <span className="receipt-time">{fmtTime(r.ts)}</span>
                </div>
              ) : (
                <div className="receipt-meta">
                  <span className="receipt-where">to {where(r)}</span>
                  <span className="receipt-bytes">
                    {fmtBytes(r.bytesSent)} out, {fmtBytes(r.bytesReceived)} back
                  </span>
                  <span className={r.ok ? "receipt-ok" : "receipt-fail"}>
                    {r.ok ? "went through" : "didn't get through"}
                  </span>
                  <span className="receipt-time">{fmtTime(r.ts)}</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

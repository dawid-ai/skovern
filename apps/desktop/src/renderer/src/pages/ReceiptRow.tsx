import type { ReceiptView } from "../../../shared/receipts.js";
import { direction, isFetch, isLocal } from "./receipt-classify.js";
import { Icon } from "../components/Icon.js";

// The pieces of one Receipts row, in florist words: who made the call, why, where it went, its
// honest flow tag and tile, and the detail line. Split out of ReceiptsPage in loop 049 (size).

function fmtBytes(n: number): string {
  return n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(1)} KB`;
}

export function fmtTime(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const BRAIN_LABEL: Record<string, string> = {
  openrouter: "OpenRouter",
  anthropic: "Claude",
  "claude-cli": "Claude Code",
  local: "your computer",
};

// Who made the call, in florist words.
export function who(r: ReceiptView): string {
  if (!isFetch(r)) return isLocal(r) ? "Your private brain" : "Your brain";
  if (r.task.startsWith("Skovern:")) return "Skovern";
  if (r.task.startsWith("skill:")) return "A connector";
  if (r.task.startsWith("Downloading")) return "A model download";
  return "A website";
}

// The plain-English reason for the call.
export function why(r: ReceiptView): string {
  if (!isFetch(r)) return r.task; // e.g. "Test my brain"
  if (r.task.startsWith("Skovern:")) return r.task.slice("Skovern:".length).trim();
  if (r.task.startsWith("skill:")) return "read a website for a skill";
  return r.task;
}

// Where it went.
export function where(r: ReceiptView): string {
  return isFetch(r) ? r.host : `${BRAIN_LABEL[r.provider] ?? r.provider}`;
}

// A private (on-machine) brain call: when the engine reported token usage, show the
// tokens it read/produced ("all on your computer") instead of bytes — nothing left.
// If no counts came back (older engine / some models), the plain honest line.
function localDetail(r: ReceiptView): string {
  if (!isFetch(r) && r.tokensOut !== undefined) {
    const inPart = r.tokensIn !== undefined ? `${r.tokensIn.toLocaleString()} tokens in, ` : "";
    return `${inPart}${r.tokensOut.toLocaleString()} out — all on your computer`;
  }
  return "stayed on your computer — nothing left";
}

// The honest flow tag: GREEN "Local" (stayed here), ORANGE "Out ↑" (you sent), BLUE
// "In ↓" (came to you). Falls back to a neutral "Online" if a call has no direction.
export function FlowTag({ r }: { r: ReceiptView }) {
  if (isLocal(r)) return <span className="tag tag-local">Local</span>;
  const dir = direction(r);
  if (dir === "out") return <span className="tag tag-out">Out ↑</span>;
  if (dir === "in") return <span className="tag tag-in">In ↓</span>;
  return <span className="tag tag-online">Online</span>;
}

// A colored icon tile for the row, same colors as its tag: green house (stayed here), orange
// arrow up (went out), blue arrow down (came in), gray for no direction.
export function FlowTile({ r }: { r: ReceiptView }) {
  if (isLocal(r)) return <span className="tile tile-green"><Icon name="house" /></span>;
  const dir = direction(r);
  if (dir === "out") return <span className="tile tile-orange"><Icon name="arrowUp" /></span>;
  if (dir === "in") return <span className="tile tile-blue"><Icon name="arrowDown" /></span>;
  return <span className="tile tile-gray"><Icon name="link" /></span>;
}

// The plain-English detail for a row: local shows its tokens/stayed line; an inbound
// event with no bytes (a new reply) just says it arrived; everything else shows the
// metadata byte summary + outcome.
export function Detail({ r }: { r: ReceiptView }) {
  if (isLocal(r)) return <span className="receipt-ok">{localDetail(r)}</span>;
  if (isFetch(r) && direction(r) === "in" && r.bytesSent === 0 && r.bytesReceived === 0) {
    return <span className="receipt-ok">arrived</span>;
  }
  const okText = isFetch(r) ? (r.ok ? "went through" : "didn't get through") : r.ok ? "answered" : "no answer";
  return (
    <>
      {fmtBytes(r.bytesSent)} out · {fmtBytes(r.bytesReceived)} back ·{" "}
      <span className={r.ok ? "receipt-ok" : "receipt-fail"}>{okText}</span>
    </>
  );
}

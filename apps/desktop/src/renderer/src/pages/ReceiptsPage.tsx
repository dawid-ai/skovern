import { useEffect, useState } from "react";
import type { ReceiptView } from "../../../shared/receipts.js";
import { direction, isFetch, isLocal, isRoutine, routineGroup } from "./receipt-classify.js";

// "What leaves your machine" — the activity log on its own page. Every call is here as a
// two-way ledger: meaningful rows carry an honest flow tag — GREEN "Local" for a private
// brain that stayed on your computer, ORANGE "Out ↑" for data you sent, BLUE "In ↓" for
// content that came to you (news, a reply, a website a skill read). The app's own routine
// background checks (news, messages, the model list) are grouped into one quiet line each
// instead of spamming a row every few seconds. Read-only; sends nothing.

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
  if (r.task.startsWith("Deskhand:")) return r.task.slice("Deskhand:".length).trim();
  if (r.task.startsWith("skill:")) return "read a website for a skill";
  return r.task;
}

// Where it went.
function where(r: ReceiptView): string {
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
function FlowTag({ r }: { r: ReceiptView }) {
  if (isLocal(r)) return <span className="tag tag-local">Local</span>;
  const dir = direction(r);
  if (dir === "out") return <span className="tag tag-out">Out ↑</span>;
  if (dir === "in") return <span className="tag tag-in">In ↓</span>;
  return <span className="tag tag-online">Online</span>;
}

// The plain-English detail for a row: local shows its tokens/stayed line; an inbound
// event with no bytes (a new reply) just says it arrived; everything else shows the
// metadata byte summary + outcome.
function Detail({ r }: { r: ReceiptView }) {
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

interface RoutineGroup {
  key: string;
  label: string;
  count: number;
  lastTs: string;
}

export function ReceiptsPage() {
  const [receipts, setReceipts] = useState<ReceiptView[] | null>(null);

  useEffect(() => {
    void window.deskhand.receipts.list().then(setReceipts);
  }, []);

  // One entry per completed call (the log also holds a "sent" line written before
  // each call leaves — the fail-closed proof; we show the "done" outcome).
  const done = (receipts ?? []).filter((r) => r.phase === "done");
  // Routine-vs-meaningful is now decided by the write-time `routine` flag, not by
  // matching task strings — so a real message the user sent is never hidden here.
  const meaningful = done.filter((r) => !isRoutine(r));

  // Group the routine polls by kind → one quiet line each, newest activity first.
  const groups = new Map<string, RoutineGroup>();
  for (const r of done) {
    if (!isFetch(r) || !isRoutine(r)) continue;
    const { key, label } = routineGroup(r);
    const g = groups.get(key) ?? { key, label, count: 0, lastTs: r.ts };
    g.count += 1;
    if (r.ts > g.lastTs) g.lastTs = r.ts;
    groups.set(key, g);
  }
  const routine = [...groups.values()].sort((a, b) => b.lastTs.localeCompare(a.lastTs));

  return (
    <section className="page">
      <header className="page-head">
        <h1>What leaves your machine</h1>
        <p>
          Every time something leaves your computer, it&apos;s written down here — with an honest tag so you can
          see what stayed private and what went online. Newest first.
        </p>
      </header>

      {receipts === null ? (
        <p className="hint">Loading the log…</p>
      ) : meaningful.length === 0 && routine.length === 0 ? (
        <p className="hint">Nothing has left your machine yet. When it does, you&apos;ll see it here.</p>
      ) : (
        <>
          {meaningful.length > 0 && (
            <div className="receipt-scroll">
              <table className="receipt-list receipt-table">
                <thead>
                  <tr>
                    <th>What happened</th>
                    <th>Where</th>
                    <th>Flow</th>
                    <th>Detail</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {meaningful.map((r, i) => (
                    <tr key={i} className="receipt-row">
                      <td className="receipt-what">
                        <span className="receipt-who">{who(r)}</span>
                        <span className="receipt-why">{why(r)}</span>
                      </td>
                      <td>
                        <span className="receipt-where">{where(r)}</span>
                      </td>
                      <td>
                        <FlowTag r={r} />
                      </td>
                      <td className="receipt-detail">
                        <Detail r={r} />
                      </td>
                      <td className="receipt-time">{fmtTime(r.ts)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {routine.length > 0 && (
            <div className="receipt-routine">
              <h2>Routine background checks</h2>
              <p className="hint">
                Deskhand quietly checking for news and messages on a timer — no business data, nothing you need
                to read. Counted here so the list above stays about what matters.
              </p>
              <ul>
                {routine.map((g) => (
                  <li key={g.key}>
                    <span className="receipt-routine-label">{g.label}</span>
                    <span className="receipt-count">{g.count}×</span>
                    <span className="receipt-time">last at {fmtTime(g.lastTs)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

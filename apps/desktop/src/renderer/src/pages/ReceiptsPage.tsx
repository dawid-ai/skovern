import { useEffect, useState } from "react";
import type { ReceiptView } from "../../../shared/receipts.js";

// "What leaves your machine" — the egress log on its own page. Every call is here:
// meaningful egress (your brain, a skill reading a website, publishing) shows in a
// table with an honest tag — GREEN "Local" for a private brain that stayed on your
// computer, ORANGE "Online" for anything that actually left. The app's own routine
// background checks (news, messages, the model list) are grouped into one quiet
// line each instead of spamming a row every few seconds. Read-only; sends nothing.

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

// The app's own repeating background checks. These leave the machine (they're online),
// but they carry no business data and fire on a timer — so we group them into one
// quiet summary line each rather than a row per poll.
const ROUTINE: Record<string, string> = {
  news: "Checked the news",
  messages: "Checked your messages",
  "model list": "Checked the model list",
};

function routineKey(r: ReceiptView): string | null {
  if (!isFetch(r) || !r.task.startsWith("Deskhand:")) return null;
  const suffix = r.task.slice("Deskhand:".length).trim();
  return suffix in ROUTINE ? suffix : null;
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
  if (r.task.startsWith("Deskhand:")) return r.task.slice("Deskhand:".length).trim();
  if (r.task.startsWith("skill:")) return "read a website for a skill";
  return r.task;
}

// Where it went.
function where(r: ReceiptView): string {
  return isFetch(r) ? r.host : `${BRAIN_LABEL[r.provider] ?? r.provider}`;
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
  const meaningful = done.filter((r) => routineKey(r) === null);

  // Group the routine polls by kind → one quiet line each, newest activity first.
  const groups = new Map<string, RoutineGroup>();
  for (const r of done) {
    const key = routineKey(r);
    if (key === null) continue;
    const g = groups.get(key) ?? { key, label: ROUTINE[key]!, count: 0, lastTs: r.ts };
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
                    <th>Left?</th>
                    <th>Detail</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {meaningful.map((r, i) => {
                    const local = isLocal(r);
                    return (
                      <tr key={i} className="receipt-row">
                        <td className="receipt-what">
                          <span className="receipt-who">{who(r)}</span>
                          <span className="receipt-why">{why(r)}</span>
                        </td>
                        <td>
                          <span className="receipt-where">{where(r)}</span>
                        </td>
                        <td>
                          <span className={local ? "tag tag-local" : "tag tag-online"}>
                            {local ? "Local" : "Online"}
                          </span>
                        </td>
                        <td className="receipt-detail">
                          {local ? (
                            <span className="receipt-ok">stayed on your computer — nothing left</span>
                          ) : isFetch(r) ? (
                            <>
                              {fmtBytes(r.bytesSent)} out · {fmtBytes(r.bytesReceived)} back ·{" "}
                              <span className={r.ok ? "receipt-ok" : "receipt-fail"}>
                                {r.ok ? "went through" : "didn't get through"}
                              </span>
                            </>
                          ) : (
                            <>
                              {fmtBytes(r.bytesSent)} out · {fmtBytes(r.bytesReceived)} back ·{" "}
                              <span className={r.ok ? "receipt-ok" : "receipt-fail"}>
                                {r.ok ? "answered" : "no answer"}
                              </span>
                            </>
                          )}
                        </td>
                        <td className="receipt-time">{fmtTime(r.ts)}</td>
                      </tr>
                    );
                  })}
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

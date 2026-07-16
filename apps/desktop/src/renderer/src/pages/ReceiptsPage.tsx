import { useEffect, useMemo, useState } from "react";
import type { ActivitySummary, ReceiptView } from "../../../shared/receipts.js";
import { intensity } from "../../../shared/receipt-calendar.js";
import { filterByRange, paginate } from "../../../shared/receipt-filter.js";
import { direction, isFetch, isLocal, isRoutine, routineGroup } from "./receipt-classify.js";

// "What leaves your machine" — the activity log on its own page. Loop 027 adds, above the
// list: a GitHub-style activity calendar (a colored square per day, darker = busier) drawn
// from a durable index that survives log rotation, so it shows your whole history. Below
// it the list gains a date filter, pages, row selection, and "Export to CSV" so you can
// keep a spreadsheet of exactly what you picked. Read-only; sends nothing.

const PAGE_SIZE = 20;
const CAL_WEEKS = 26; // ~6 months of history in the grid

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
  if (r.task.startsWith("Skovern:")) return "Skovern";
  if (r.task.startsWith("skill:")) return "A connector";
  if (r.task.startsWith("Downloading")) return "A model download";
  return "A website";
}

// The plain-English reason for the call.
function why(r: ReceiptView): string {
  if (!isFetch(r)) return r.task; // e.g. "Test my brain"
  if (r.task.startsWith("Skovern:")) return r.task.slice("Skovern:".length).trim();
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

// The calendar's day squares as week-columns (each column 7 days, Sunday→Saturday),
// oldest week first, ending on the week that holds `today`. Pure date math in UTC so it
// matches the index's day keys and is identical on any machine.
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function buildGrid(today: string, weeks: number): string[][] {
  const end = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(end.getTime())) return [];
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (weeks * 7 - 1));
  start.setUTCDate(start.getUTCDate() - start.getUTCDay()); // back up to Sunday
  const cols: string[][] = [];
  const cur = new Date(start);
  while (cur <= end) {
    const col: string[] = [];
    for (let i = 0; i < 7; i++) {
      col.push(ymd(cur));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    cols.push(col);
  }
  return cols;
}

function Calendar({
  summary,
  onPickDay,
}: {
  summary: ActivitySummary;
  onPickDay: (day: string) => void;
}) {
  const grid = useMemo(() => buildGrid(summary.today, CAL_WEEKS), [summary.today]);
  const max = useMemo(() => Math.max(0, ...Object.values(summary.counts)), [summary.counts]);
  const total = useMemo(() => Object.values(summary.counts).reduce((a, b) => a + b, 0), [summary.counts]);

  return (
    <div className="cal">
      <div className="cal-head">
        <h2>Your activity</h2>
        <p className="hint">
          {total === 0
            ? "Nothing yet — the days will fill in as Skovern does things for you."
            : `${total.toLocaleString()} ${total === 1 ? "thing has" : "things have"} happened. Darker means busier. Click a day to see just that day.`}
        </p>
      </div>
      <div className="cal-scroll">
        <div className="cal-grid" role="grid" aria-label="Activity calendar">
          {grid.map((col, ci) => (
            <div className="cal-col" role="row" key={ci}>
              {col.map((day) => {
                const future = day > summary.today;
                const count = summary.counts[day] ?? 0;
                const level = future ? 0 : intensity(count, max);
                return (
                  <button
                    key={day}
                    type="button"
                    role="gridcell"
                    className={`cal-day cal-${level}${future ? " cal-future" : ""}`}
                    title={future ? day : `${day}: ${count} ${count === 1 ? "thing" : "things"}`}
                    disabled={future}
                    onClick={() => onPickDay(day)}
                    aria-label={`${day}, ${count} ${count === 1 ? "thing" : "things"}`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ReceiptsPage() {
  const [receipts, setReceipts] = useState<ReceiptView[] | null>(null);
  const [activity, setActivity] = useState<ActivitySummary | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [pageIx, setPageIx] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [savedTo, setSavedTo] = useState<string | null>(null);

  // The calendar's full history loads once. The table re-loads when the date range
  // changes: with no range it's the recent window; with a range, main returns the full
  // retained history for those dates (spanning archives), so a calendar click reaches
  // rows that aged out of the recent window. A reload clears selection (the idx pairing
  // is only valid within one loaded list).
  useEffect(() => {
    void window.skovern.receipts.activity().then(setActivity);
  }, []);
  useEffect(() => {
    const range = from || to ? { from: from || undefined, to: to || undefined } : undefined;
    let alive = true;
    void window.skovern.receipts.list(range).then((r) => {
      if (!alive) return;
      setReceipts(r);
      setSelected(new Set());
    });
    return () => {
      alive = false;
    };
  }, [from, to]);

  // Pair each meaningful (completed, non-routine) receipt with its stable index in the
  // loaded list, so selection survives filtering + paging. Routine polls are summarized
  // below, never selectable.
  const pairs = useMemo(() => {
    const all = receipts ?? [];
    return all
      .map((r, idx) => ({ r, idx }))
      .filter(({ r }) => r.phase === "done" && !isRoutine(r));
  }, [receipts]);

  // Filter the meaningful rows to the picked date range (identity-preserving, so the
  // idx pairing holds), then page them.
  const visible = useMemo(() => {
    const rows = pairs.map((p) => p.r);
    const allowed = new Set(filterByRange(rows, { from: from || undefined, to: to || undefined }));
    return pairs.filter((p) => allowed.has(p.r));
  }, [pairs, from, to]);

  const pages = useMemo(() => paginate(visible, PAGE_SIZE), [visible]);
  const page = pages[Math.min(pageIx, Math.max(0, pages.length - 1))] ?? [];

  // Selecting resets the "saved" note; keep the page index in range as filters change.
  function updateRange(nextFrom: string, nextTo: string): void {
    setFrom(nextFrom);
    setTo(nextTo);
    setPageIx(0);
    setSavedTo(null);
  }
  function toggle(idx: number): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
    setSavedTo(null);
  }
  const visibleIdx = visible.map((p) => p.idx);
  const allVisibleSelected = visibleIdx.length > 0 && visibleIdx.every((i) => selected.has(i));
  function toggleAll(): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visibleIdx.forEach((i) => next.delete(i));
      else visibleIdx.forEach((i) => next.add(i));
      return next;
    });
    setSavedTo(null);
  }
  async function exportSelected(): Promise<void> {
    const rows = (receipts ?? []).filter((_r, idx) => selected.has(idx));
    if (rows.length === 0) return;
    const dest = await window.skovern.receipts.exportCsv(rows);
    if (dest) setSavedTo(dest);
  }

  const routine = useMemo(() => {
    const done = (receipts ?? []).filter((r) => r.phase === "done");
    const groups = new Map<string, RoutineGroup>();
    for (const r of done) {
      if (!isFetch(r) || !isRoutine(r)) continue;
      const { key, label } = routineGroup(r);
      const g = groups.get(key) ?? { key, label, count: 0, lastTs: r.ts };
      g.count += 1;
      if (r.ts > g.lastTs) g.lastTs = r.ts;
      groups.set(key, g);
    }
    return [...groups.values()].sort((a, b) => b.lastTs.localeCompare(a.lastTs));
  }, [receipts]);

  const selectedCount = selected.size;

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
      ) : (
        <>
          {activity && <Calendar summary={activity} onPickDay={(day) => updateRange(day, day)} />}

          <div className="receipt-controls">
            <label>
              From <input type="date" value={from} max={to || undefined} onChange={(e) => updateRange(e.target.value, to)} />
            </label>
            <label>
              To <input type="date" value={to} min={from || undefined} onChange={(e) => updateRange(from, e.target.value)} />
            </label>
            {(from || to) && (
              <button type="button" className="link-btn" onClick={() => updateRange("", "")}>
                Clear dates
              </button>
            )}
            <span className="receipt-controls-spacer" />
            <button type="button" className="primary" disabled={selectedCount === 0} onClick={() => void exportSelected()}>
              Export {selectedCount > 0 ? `${selectedCount} ` : ""}to CSV
            </button>
          </div>
          {savedTo && <p className="hint receipt-saved">Saved to {savedTo}</p>}

          {visible.length === 0 ? (
            <p className="hint">
              {from || to
                ? "No activity in those dates. Try a wider range or clear the dates."
                : "Nothing has left your machine yet. When it does, you'll see it here."}
            </p>
          ) : (
            <>
              <div className="receipt-scroll">
                <table className="receipt-list receipt-table">
                  <thead>
                    <tr>
                      <th className="receipt-pick">
                        <input
                          type="checkbox"
                          checked={allVisibleSelected}
                          onChange={toggleAll}
                          aria-label="Select all shown"
                        />
                      </th>
                      <th>What happened</th>
                      <th>Where</th>
                      <th>Flow</th>
                      <th>Detail</th>
                      <th>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.map(({ r, idx }) => (
                      <tr key={idx} className="receipt-row">
                        <td className="receipt-pick">
                          <input
                            type="checkbox"
                            checked={selected.has(idx)}
                            onChange={() => toggle(idx)}
                            aria-label={`Select ${who(r)} ${why(r)}`}
                          />
                        </td>
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

              {pages.length > 1 && (
                <div className="receipt-pager">
                  <button type="button" disabled={pageIx <= 0} onClick={() => setPageIx((p) => Math.max(0, p - 1))}>
                    ← Newer
                  </button>
                  <span className="hint">
                    Page {Math.min(pageIx, pages.length - 1) + 1} of {pages.length}
                  </span>
                  <button
                    type="button"
                    disabled={pageIx >= pages.length - 1}
                    onClick={() => setPageIx((p) => Math.min(pages.length - 1, p + 1))}
                  >
                    Older →
                  </button>
                </div>
              )}
            </>
          )}

          {routine.length > 0 && (
            <div className="receipt-routine">
              <h2>Routine background checks</h2>
              <p className="hint">
                Skovern quietly checking for news and messages on a timer — no business data, nothing you need
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

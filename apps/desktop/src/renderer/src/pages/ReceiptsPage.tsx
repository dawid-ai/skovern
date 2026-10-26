import { useEffect, useMemo, useState } from "react";
import type { ActivitySummary, ReceiptView } from "../../../shared/receipts.js";
import { Calendar } from "./ReceiptCalendar.js";
import { filterByRange, paginate } from "../../../shared/receipt-filter.js";
import { isFetch, isRoutine, routineGroup } from "./receipt-classify.js";
import { Detail, FlowTag, FlowTile, fmtTime, where, who, why } from "./ReceiptRow.js";
import { Icon } from "../components/Icon.js";

// "What leaves your machine" — the activity log on its own page. Loop 027 adds, above the
// list: a GitHub-style activity calendar (a colored square per day, darker = busier) drawn
// from a durable index that survives log rotation, so it shows your whole history. Below
// it the list gains a date filter, pages, row selection, and "Export to CSV" so you can
// keep a spreadsheet of exactly what you picked. Read-only; sends nothing.

const PAGE_SIZE = 20;

interface RoutineGroup {
  key: string;
  label: string;
  count: number;
  lastTs: string;
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
                          <span className="receipt-what-in">
                            <FlowTile r={r} />
                            <span>
                              <span className="receipt-who">{who(r)}</span>
                              <span className="receipt-why">{why(r)}</span>
                            </span>
                          </span>
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
            <section className="group receipt-routine">
              <h2>Routine background checks</h2>
              <ul className="g-card">
                {routine.map((g) => (
                  <li key={g.key} className="g-row">
                    <span className="tile tile-gray">
                      <Icon name="refresh" />
                    </span>
                    <span className="receipt-routine-label g-main">{g.label}</span>
                    <span className="g-trail">
                      <span className="receipt-count">{g.count}×</span>
                      <span className="receipt-time">last at {fmtTime(g.lastTs)}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="hint g-foot">
                Skovern quietly checking for news and messages on a timer — no business data, nothing you need
                to read. Counted here so the list above stays about what matters.
              </p>
            </section>
          )}
        </>
      )}
    </section>
  );
}

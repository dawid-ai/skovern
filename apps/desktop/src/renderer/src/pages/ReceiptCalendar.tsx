import { useMemo } from "react";
import type { ActivitySummary } from "../../../shared/receipts.js";
import { intensity } from "../../../shared/receipt-calendar.js";

// The Receipts activity calendar (loop 027): a colored square per day, darker = busier, drawn from
// a durable index that survives log rotation. Split out of ReceiptsPage in loop 049 (size).

const CAL_WEEKS = 26; // ~6 months of history in the grid

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

export function Calendar({
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
    <div className="cal heat-card">
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

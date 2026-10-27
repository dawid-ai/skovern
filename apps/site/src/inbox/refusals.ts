// Refused webhooks (bad signatures, bodies over the limit, failed reads) are
// logged as one line a minute with counts, not one line each: a flood of bad
// requests must not flood the logs too.

/** A svix-id as it may appear in a log: Svix's own characters only, so a
 *  forged header can't write anything else into the logs. */
export function safeSvixId(raw: string | undefined): string {
  return (raw ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "none";
}

export class RefusalLog {
  private counts = new Map<string, number>();
  /** The last svix-id seen per reason, already made log-safe. */
  private lastId = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly everyMs = 60_000) {}

  /** Count one refusal; the first in a quiet minute starts the clock. */
  note(reason: string, svixId?: string): void {
    this.counts.set(reason, (this.counts.get(reason) ?? 0) + 1);
    if (svixId !== undefined) this.lastId.set(reason, safeSvixId(svixId));
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.everyMs);
    this.timer.unref();
  }

  /** Write the line for what's been counted, if anything, and start over. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.counts.size === 0) return;
    const total = [...this.counts.values()].reduce((a, b) => a + b, 0);
    const parts = [...this.counts]
      .map(([reason, n]) => `${reason} ${n}${this.lastId.has(reason) ? ` (last svix-id ${this.lastId.get(reason)})` : ""}`)
      .join(", ");
    this.counts = new Map();
    this.lastId = new Map();
    console.warn(`[inbox] webhook refused ${total} time${total === 1 ? "" : "s"} in the last minute (${parts})`);
  }
}

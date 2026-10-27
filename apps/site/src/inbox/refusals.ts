// Refused webhook signatures are logged as one line a minute with counts, not
// one line each: a flood of bad requests must not flood the logs too.

export class RefusalLog {
  private counts = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly everyMs = 60_000) {}

  /** Count one refusal; the first in a quiet minute starts the clock. */
  note(reason: string): void {
    this.counts.set(reason, (this.counts.get(reason) ?? 0) + 1);
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
    const parts = [...this.counts].map(([reason, n]) => `${reason} ${n}`).join(", ");
    this.counts = new Map();
    console.warn(`[inbox] webhook refused ${total} time${total === 1 ? "" : "s"} in the last minute (${parts})`);
  }
}

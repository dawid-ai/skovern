import { processOne, type ForwardDeps } from "./forward.js";

// Works through pending received emails: right after a webhook records one
// (kick), and every minute for retries (start). One run at a time per process;
// across processes, the store's lease keeps two from taking the same email.

export class InboxWorker {
  private running: Promise<void> | null = null;
  private again = false;

  constructor(
    private readonly deps: ForwardDeps,
    private readonly batch = 25,
  ) {}

  /** Start a run now, or one more after the current run. */
  kick(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        this.kick();
      }
    });
  }

  /** Wait until no run is going (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.running) await this.running;
  }

  /** Run every `everyMs` (unref'd). Returns a stop function. */
  start(everyMs = 60_000): () => void {
    const timer = setInterval(() => this.kick(), everyMs);
    timer.unref();
    this.kick();
    return () => clearInterval(timer);
  }

  private async run(): Promise<void> {
    try {
      const expired = await this.deps.store.expireStale();
      if (expired) console.warn(`[inbox] ${expired} email(s) waited over 24 hours and stay in Resend`);
      for (let i = 0; i < this.batch; i += 1) {
        const job = await this.deps.store.lease();
        if (!job) break;
        const outcome = await processOne(this.deps, job);
        console.log(`[inbox] email ${job.emailId}: ${outcome}`);
      }
    } catch (err) {
      // A leased email stays pending and comes back after its lease.
      console.error("[inbox] worker run failed:", (err as Error).message);
    }
  }
}

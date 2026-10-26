import type pg from "pg";
import { deliverWelcome, type WelcomeDeps } from "../waitlist/welcome.js";

// Hourly cleanup of dead credentials (ledger token-session-expiry-sweep):
// expired or used magic links, expired sessions, and expired waitlist detail
// tokens. A day of grace on magic links keeps "that link was used" debuggable.

export interface SweepCounts {
  magicTokens: number;
  sessions: number;
  waitlistTokens: number;
}

export async function sweepExpired(pool: pg.Pool): Promise<SweepCounts> {
  const magic = await pool.query(
    `DELETE FROM magic_tokens WHERE expires_at < now() - interval '1 day'`,
  );
  const sessions = await pool.query(`DELETE FROM sessions WHERE expires_at < now()`);
  const waitlist = await pool.query(
    `DELETE FROM waitlist_tokens WHERE expires_at IS NOT NULL AND expires_at < now()`,
  );
  return {
    magicTokens: magic.rowCount ?? 0,
    sessions: sessions.rowCount ?? 0,
    waitlistTokens: waitlist.rowCount ?? 0,
  };
}

/** Run the sweep now and then every `everyMs`. The timer is unref'd so it never
 *  holds the process open during shutdown. Returns a stop function. */
export function startSweep(pool: pg.Pool, everyMs = 60 * 60_000): () => void {
  const run = (): void => {
    sweepExpired(pool).catch((err: unknown) =>
      console.error("[sweep] failed:", (err as Error).message),
    );
  };
  run();
  const timer = setInterval(run, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Mail welcomes that waited in the backlog (over budget at signup, or a failed
 * send), oldest first, while the budget has room. Stops at the first failed
 * send so a mail outage doesn't spin. Returns how many went out.
 */
export async function sendWelcomeBacklog(deps: WelcomeDeps, max = 50): Promise<number> {
  let sent = 0;
  while (sent < max) {
    const job = await deps.store.claimBacklog();
    if (!job) break;
    if (!(await deliverWelcome(deps, job))) break;
    sent += 1;
  }
  return sent;
}

/** Run the backlog sender every `everyMs` (unref'd). Returns a stop function. */
export function startWelcomeBacklog(deps: WelcomeDeps, everyMs = 5 * 60_000): () => void {
  let running = false;
  const run = (): void => {
    if (running) return;
    running = true;
    sendWelcomeBacklog(deps)
      .catch((err: unknown) => console.error("[welcome backlog] failed:", (err as Error).message))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(run, everyMs);
  timer.unref();
  run();
  return () => clearInterval(timer);
}

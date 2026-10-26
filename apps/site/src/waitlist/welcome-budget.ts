import type pg from "pg";

// A global cap on welcome emails, kept in Postgres so every api instance and
// restart sees the same count (loop 051 SECURE B2). Resend's free tier allows
// 100 emails a day; the defaults stay under it with room for sign-in links.
// Over budget, a signup is still saved with welcome_sent_at NULL, and the
// backlog sender (server/sweep.ts) mails it once the budget frees up.

export interface WelcomeBudget {
  perHour: number;
  perDay: number;
}

export const DEFAULT_WELCOME_BUDGET: WelcomeBudget = { perHour: 30, perDay: 90 };

export const WELCOME_BUDGET_MIGRATION = `
CREATE TABLE IF NOT EXISTS waitlist_welcome_sends (
  id       bigserial PRIMARY KEY,
  sent_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS waitlist_welcome_sends_at ON waitlist_welcome_sends (sent_at);
`;

/** A repeat signup inside this window gets no second welcome email. */
export const WELCOME_COOLDOWN_HOURS = 24;

/**
 * Inside the caller's transaction: if this person's welcome is due and the
 * budget has room, mark it sent and log one send. Returns the log row id (the
 * claim, handed back with release on failure) or null. A transaction-scoped
 * advisory lock serializes every claim, so two signups can't both take the
 * last slot.
 */
export async function claimWelcome(client: pg.PoolClient, waitlistId: string, budget: WelcomeBudget): Promise<string | null> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('waitlist:welcome-budget'))");
  const used = await client.query<{ hour: string; day: string }>(
    `SELECT count(*) FILTER (WHERE sent_at > now() - interval '1 hour') AS hour, count(*) AS day
       FROM waitlist_welcome_sends WHERE sent_at > now() - interval '1 day'`,
  );
  const hour = Number(used.rows[0]?.hour ?? 0);
  const day = Number(used.rows[0]?.day ?? 0);
  if (hour >= budget.perHour || day >= budget.perDay) return null;
  const claimed = await client.query(
    `UPDATE waitlist SET welcome_sent_at = now()
      WHERE id = $1 AND (welcome_sent_at IS NULL OR welcome_sent_at < now() - ($2 || ' hours')::interval)
      RETURNING id`,
    [waitlistId, String(WELCOME_COOLDOWN_HOURS)],
  );
  if (!claimed.rowCount) return null;
  const log = await client.query<{ id: string }>(`INSERT INTO waitlist_welcome_sends DEFAULT VALUES RETURNING id`);
  return log.rows[0]?.id ?? null;
}

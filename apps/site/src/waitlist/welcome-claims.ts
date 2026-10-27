import type pg from "pg";
import type { WelcomeJob } from "./store.js";
import {
  BACKLOG_MAX_AGE_HOURS,
  budgetRoom,
  claimRow,
  lockBudget,
  logBudgetSpent,
  returnSlot,
  waitingCount,
  type WelcomeBudget,
} from "./welcome-budget.js";

// Settling and re-claiming welcome emails outside a signup: the backlog
// sender's claim, and handing a claim back after a failed or refused send.
// Split out of store.ts (module size).

/** The welcome send failed: give the claim and its budget slot back, so the
 *  backlog sender (or the next join) retries it. */
export async function releaseWelcome(pool: pg.Pool, id: string, claim: string): Promise<void> {
  await pool.query(`UPDATE waitlist SET welcome_sent_at = NULL WHERE id = $1`, [id]);
  await returnSlot(pool, claim);
}

/** The mail service refused this address (400 or 422): it won't take it, so
 *  mark the welcome skipped and give the budget slot back. A repeat join over
 *  a day later gets another try. */
export async function skipWelcome(pool: pg.Pool, id: string, claim: string): Promise<void> {
  await pool.query(
    `UPDATE waitlist SET welcome_sent_at = NULL, welcome_skipped = 'refused', welcome_skipped_at = now() WHERE id = $1`,
    [id],
  );
  await returnSlot(pool, claim);
}

/** Claim the NEWEST signup still waiting for its welcome, if it's under a
 *  day old and the backlog's share of the budget has room. Older waiting
 *  rows are marked skipped ('expired'): after a flood, real people who
 *  joined since get their email first, and junk ages out instead of queuing
 *  for days. Takes the budget lock before any row lock, like join. */
export async function claimBacklog(pool: pg.Pool, budget: WelcomeBudget): Promise<WelcomeJob | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockBudget(client);
    await client.query(
      `UPDATE waitlist SET welcome_skipped = 'expired', welcome_skipped_at = now()
        WHERE welcome_sent_at IS NULL AND welcome_skipped IS NULL
          AND created_at < now() - ($1 || ' hours')::interval`,
      [String(BACKLOG_MAX_AGE_HOURS)],
    );
    const room = await budgetRoom(client, budget, "backlog");
    if (room !== "ok") {
      const waiting = await waitingCount(client);
      await client.query("COMMIT");
      if (waiting > 0 && room === "spent") logBudgetSpent(waiting);
      return null;
    }
    const next = await client.query<{ id: string; email: string; name: string; number: string }>(
      `SELECT id, email, name, number FROM waitlist
        WHERE welcome_sent_at IS NULL AND welcome_skipped IS NULL
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    const row = next.rows[0];
    const claim = row ? await claimRow(client, row.id) : null;
    await client.query("COMMIT");
    if (!row || !claim) return null;
    return { id: row.id, email: row.email, name: row.name, number: Number(row.number), claim };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

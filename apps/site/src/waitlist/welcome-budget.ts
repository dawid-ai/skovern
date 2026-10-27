import type pg from "pg";
import { bouncePaused, FEEDBACK_MIGRATION, logWelcomesPaused, welcomeBounceStats } from "./bounce-pause.js";
import {
  countUse,
  DEFAULT_QUOTA,
  lockMailBudget,
  sharedRoom,
  uncountUse,
  USAGE_MIGRATION,
  type ResendQuota,
} from "../server/resend-usage.js";

// A global cap on welcome emails, kept in Postgres so every api instance and
// restart sees the same count (loop 051 SECURE B2, N1). Each welcome also counts
// against the shared Resend quota (server/resend-usage.ts, loop 052), which
// inbox forwards and received mail use too. Over either budget, a signup is
// still saved with welcome_sent_at NULL, and the backlog sender
// (server/sweep.ts) mails it later, if it's still fresh.

export interface WelcomeBudget {
  perHour: number;
  perDay: number;
  /** The shared Resend quota. Defaults to 100 a day with 15 kept free. */
  quota?: ResendQuota;
}

export const DEFAULT_WELCOME_BUDGET: WelcomeBudget = { perHour: 20, perDay: 50 };

/** Who is asking for a slot. The backlog may use at most half of each hour, so
 *  a flood that fills the backlog can't crowd out people joining right now. */
export type Claimant = "live" | "backlog";

export const WELCOME_BUDGET_MIGRATION = `
CREATE TABLE IF NOT EXISTS waitlist_welcome_sends (
  id       bigserial PRIMARY KEY,
  sent_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS waitlist_welcome_sends_at ON waitlist_welcome_sends (sent_at);
-- Resend's ID for the sent welcome: bounce events name it (bounce-pause.ts).
ALTER TABLE waitlist_welcome_sends ADD COLUMN IF NOT EXISTS resend_id text;
CREATE INDEX IF NOT EXISTS waitlist_welcome_sends_resend ON waitlist_welcome_sends (resend_id);
-- Why a welcome will never go out: 'expired' (waited over a day in the
-- backlog) or 'refused' (the mail service rejected the address).
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS welcome_skipped text;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS welcome_skipped_at timestamptz;
${FEEDBACK_MIGRATION}
${USAGE_MIGRATION}`;

/** A repeat signup inside this window gets no second welcome email. */
export const WELCOME_COOLDOWN_HOURS = 24;
/** A backlog welcome older than this is skipped, not sent. */
export const BACKLOG_MAX_AGE_HOURS = 24;

/** Take the budget lock for the rest of the caller's transaction. It's the
 *  shared Resend lock, so a welcome and a forward can't both take the last
 *  slot. Every claim takes it before any row lock, so claimers can't deadlock. */
export const lockBudget = lockMailBudget;

/** The shared-quota ref of one welcome claim. */
const useRef = (claim: string): string => `welcome/${claim}`;

/** Why a welcome can't go out now: the budget is spent, or welcomes are
 *  paused for bounces (bounce-pause.ts). */
export type Room = "ok" | "spent" | "paused";

/** Under the budget lock: is there a slot for this claimant? */
export async function budgetRoom(client: pg.PoolClient, budget: WelcomeBudget, who: Claimant): Promise<Room> {
  const stats = await welcomeBounceStats(client);
  if (bouncePaused(stats)) {
    logWelcomesPaused(stats);
    return "paused";
  }
  if (!(await sharedRoom(client, budget.quota ?? DEFAULT_QUOTA))) return "spent";
  const used = await client.query<{ hour: string; day: string }>(
    `SELECT count(*) FILTER (WHERE sent_at > now() - interval '1 hour') AS hour, count(*) AS day
       FROM waitlist_welcome_sends WHERE sent_at > now() - interval '1 day'`,
  );
  const hour = Number(used.rows[0]?.hour ?? 0);
  const day = Number(used.rows[0]?.day ?? 0);
  const hourCap = who === "backlog" ? Math.floor(budget.perHour / 2) : budget.perHour;
  return hour < hourCap && day < budget.perDay ? "ok" : "spent";
}

/**
 * Under the budget lock, with room confirmed: mark this person's welcome as
 * sent and log one send. Returns the log row id (the claim, handed back if the
 * send fails) or null when the welcome isn't due.
 */
export async function claimRow(client: pg.PoolClient, waitlistId: string): Promise<string | null> {
  const claimed = await client.query(
    `UPDATE waitlist SET welcome_sent_at = now()
      WHERE id = $1 AND welcome_skipped IS NULL
        AND (welcome_sent_at IS NULL OR welcome_sent_at < now() - ($2 || ' hours')::interval)
      RETURNING id`,
    [waitlistId, String(WELCOME_COOLDOWN_HOURS)],
  );
  if (!claimed.rowCount) return null;
  const log = await client.query<{ id: string }>(`INSERT INTO waitlist_welcome_sends DEFAULT VALUES RETURNING id`);
  const claim = log.rows[0]?.id ?? null;
  if (claim) await countUse(client, useRef(claim), "welcome");
  return claim;
}

/** Hand a claim's send slot back, in both budgets (the send didn't happen). */
export async function returnSlot(db: pg.Pool, claim: string): Promise<void> {
  await db.query(`DELETE FROM waitlist_welcome_sends WHERE id = $1`, [claim]);
  await uncountUse(db, useRef(claim));
}

/** How many signups are still waiting for a welcome (for the budget log line). */
export async function waitingCount(client: pg.PoolClient | pg.Pool): Promise<number> {
  const r = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM waitlist WHERE welcome_sent_at IS NULL AND welcome_skipped IS NULL`,
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** One log line when the budget runs out, at most every 10 minutes per process,
 *  so a flood doesn't also flood the logs. */
let lastSpentLog = 0;
export function logBudgetSpent(waiting: number, now: number = Date.now()): void {
  if (now - lastSpentLog < 10 * 60_000) return;
  lastSpentLog = now;
  console.warn(`[waitlist] welcome budget spent; ${waiting} waiting`);
}

/** Test seam: let the next budget-spent line through. */
export function resetBudgetLog(): void {
  lastSpentLog = 0;
}

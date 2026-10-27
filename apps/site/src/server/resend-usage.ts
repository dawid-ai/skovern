import type pg from "pg";

// One count of everything that uses Resend's daily quota (loop 052 B1). Resend
// counts each email sent AND each email received, per UTC day; the free plan
// allows 100. Every use is one row with a unique `ref`, so a retry or replay
// never counts twice:
//   received/<emailId>   an email.received webhook (forwarded, held, or skipped)
//   welcome/<claim>      a waitlist welcome
//   forward/<emailId>    a forward, and forward/<emailId>/names its names-only resend
//   summary/<day>        the day's one "forwarding paused" alert
// Senders check their own cap AND `used < quota - reserve` under one lock. The
// reserve is left for Dawid's own replies from Gmail and for slack.

export interface ResendQuota {
  /** Resend's emails per UTC day, sent plus received. */
  quota: number;
  /** Kept free for mail this server doesn't send (replies from Gmail). */
  reserve: number;
}

export const DEFAULT_QUOTA: ResendQuota = { quota: 100, reserve: 15 };

export type UsageKind = "received" | "welcome" | "forward" | "names" | "summary";

export const USAGE_MIGRATION = `
CREATE TABLE IF NOT EXISTS resend_usage (
  ref   text PRIMARY KEY,
  kind  text NOT NULL,
  day   date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS resend_usage_day ON resend_usage (day, kind);
`;

export const TODAY_UTC = `(now() AT TIME ZONE 'UTC')::date`;

type Db = pg.PoolClient | pg.Pool;

/** Take the shared mail-budget lock for the rest of the caller's transaction.
 *  Welcome claims and forward claims both take it, before any row lock. */
export async function lockMailBudget(client: pg.PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('resend:budget'))");
}

/** Today's (UTC) uses, all kinds or one. */
export async function usedToday(db: Db, kind?: UsageKind): Promise<number> {
  const r = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM resend_usage WHERE day = ${TODAY_UTC} AND ($1::text IS NULL OR kind = $1)`,
    [kind ?? null],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** Room for one more send under the shared budget. `useReserve` lets the one
 *  daily alert dip into the reserve: it matters most when the budget is gone. */
export async function sharedRoom(db: Db, q: ResendQuota, useReserve = false): Promise<boolean> {
  return (await usedToday(db)) < q.quota - (useReserve ? 0 : q.reserve);
}

/** Count one use. False when this ref was already counted. */
export async function countUse(db: Db, ref: string, kind: UsageKind): Promise<boolean> {
  const r = await db.query(`INSERT INTO resend_usage (ref, kind) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [ref, kind]);
  return r.rowCount === 1;
}

/** Hand a use back (the send never happened). */
export async function uncountUse(db: Db, ref: string): Promise<void> {
  await db.query(`DELETE FROM resend_usage WHERE ref = $1`, [ref]);
}

export async function pruneUsage(db: Db): Promise<void> {
  await db.query(`DELETE FROM resend_usage WHERE day < ${TODAY_UTC} - 7`);
}

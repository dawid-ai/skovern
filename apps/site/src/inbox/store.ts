import type pg from "pg";
import {
  countUse,
  lockMailBudget,
  pruneUsage,
  sharedRoom,
  TODAY_UTC,
  uncountUse,
  usedToday,
  USAGE_MIGRATION,
  type ResendQuota,
} from "../server/resend-usage.js";

// What the inbox forwarder remembers, in Postgres so every api instance and
// restart agrees: webhook IDs already handled (replays), and each received
// email's state. A received email is `pending` until the worker settles it, so
// nothing is lost when Resend or the api has a bad minute. No addresses,
// subjects, or bodies: Resend keeps the mail itself.

const MIGRATION = `
CREATE TABLE IF NOT EXISTS resend_hook_ids (
  svix_id  text PRIMARY KEY,
  seen_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS resend_hook_ids_seen ON resend_hook_ids (seen_at);
CREATE TABLE IF NOT EXISTS inbox_mail (
  email_id  text PRIMARY KEY,
  outcome   text NOT NULL,
  at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE inbox_mail ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0;
ALTER TABLE inbox_mail ADD COLUMN IF NOT EXISTS next_try timestamptz NOT NULL DEFAULT now();
-- Set once Resend refused the full forward, so a retry goes straight to the
-- names-only version instead of reusing the full one's Idempotency-Key.
ALTER TABLE inbox_mail ADD COLUMN IF NOT EXISTS names_only boolean NOT NULL DEFAULT false;
ALTER TABLE inbox_mail DROP CONSTRAINT IF EXISTS inbox_mail_outcome_check;
ALTER TABLE inbox_mail ADD CONSTRAINT inbox_mail_outcome_check
  CHECK (outcome IN ('pending', 'forwarded', 'held', 'held_spam', 'held_auto', 'skipped', 'refused', 'gone'));
CREATE INDEX IF NOT EXISTS inbox_mail_at ON inbox_mail (at);
CREATE INDEX IF NOT EXISTS inbox_mail_pending ON inbox_mail (next_try) WHERE outcome = 'pending';
${USAGE_MIGRATION}`;

/** A webhook ID is remembered this long; Svix stops retrying well before. */
export const HOOK_ID_DAYS = 7;
/** A pending email older than this is held: Resend's Idempotency-Key lasts 24 hours. */
export const PENDING_MAX_HOURS = 24;

/** held: over budget; held_spam: the sender may be forged and the flagged cap
 *  is used up; held_auto: an auto-reply or other machine mail. All stay in
 *  Resend, unforwarded. */
export type Settled = "forwarded" | "held" | "held_spam" | "held_auto" | "skipped" | "refused" | "gone";

/** A send slot: taken, or refused by its own daily cap, or by the shared quota. */
export type SlotClaim = "ok" | "cap" | "quota";

/** Today's alert: claimed now (send it), already claimed, or no room even in the reserve. */
export interface SummaryClaim {
  status: "claimed" | "already" | "full";
  /** The UTC day, for the Idempotency-Key and the skip log. */
  day: string;
}

export interface Lease {
  emailId: string;
  attempts: number;
  namesOnly: boolean;
}

export class InboxStore {
  constructor(private readonly pool: pg.Pool) {}

  async migrate(): Promise<void> {
    await this.pool.query(MIGRATION);
  }

  /** Remember a webhook ID. False when it was already seen (a replay). */
  async firstSight(svixId: string): Promise<boolean> {
    const r = await this.pool.query(`INSERT INTO resend_hook_ids (svix_id) VALUES ($1) ON CONFLICT DO NOTHING`, [svixId]);
    return r.rowCount === 1;
  }

  /** Recording failed and Svix will retry: forget the ID so the retry counts. */
  async forget(svixId: string): Promise<void> {
    await this.pool.query(`DELETE FROM resend_hook_ids WHERE svix_id = $1`, [svixId]);
  }

  /** A received email: queue it and count it against Resend's quota (received
   *  mail counts whether it's forwarded or not). False when already known. */
  async receive(emailId: string): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO inbox_mail (email_id, outcome) VALUES ($1, 'pending') ON CONFLICT DO NOTHING`,
      [emailId],
    );
    await countUse(this.pool, `received/${emailId}`, "received");
    return r.rowCount === 1;
  }

  /** Pending too long: leave it in Resend. Returns how many. */
  async expireStale(): Promise<number> {
    const r = await this.pool.query(
      `UPDATE inbox_mail SET outcome = 'held'
        WHERE outcome = 'pending' AND at < now() - ($1 || ' hours')::interval`,
      [String(PENDING_MAX_HOURS)],
    );
    return r.rowCount ?? 0;
  }

  /** Take the oldest pending email that's due, for two minutes. Another worker
   *  (or this one after a crash) takes it again only after that. */
  async lease(): Promise<Lease | null> {
    const r = await this.pool.query<{ email_id: string; attempts: number; names_only: boolean }>(
      `UPDATE inbox_mail SET attempts = attempts + 1, next_try = now() + interval '2 minutes'
        WHERE email_id = (SELECT email_id FROM inbox_mail
                           WHERE outcome = 'pending' AND next_try <= now()
                           ORDER BY at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING email_id, attempts, names_only`,
    );
    const row = r.rows[0];
    return row ? { emailId: row.email_id, attempts: row.attempts, namesOnly: row.names_only } : null;
  }

  async settle(emailId: string, outcome: Settled): Promise<void> {
    await this.pool.query(`UPDATE inbox_mail SET outcome = $2 WHERE email_id = $1`, [emailId, outcome]);
  }

  /** This attempt failed: stay pending, and try again after a wait that grows
   *  a minute per attempt, up to half an hour. */
  async retryLater(emailId: string, attempts: number): Promise<void> {
    await this.pool.query(
      `UPDATE inbox_mail SET next_try = now() + ($2 || ' minutes')::interval WHERE email_id = $1`,
      [emailId, String(Math.min(Math.max(attempts, 1), 30))],
    );
  }

  async markNamesOnly(emailId: string): Promise<void> {
    await this.pool.query(`UPDATE inbox_mail SET names_only = true WHERE email_id = $1`, [emailId]);
  }

  /** Under the shared lock, take a send slot counted as `ref`: room under the
   *  shared quota, and (for forwards) under `perDay`. A ref already counted
   *  (a retry) always has its slot. */
  async claimSlot(ref: string, kind: "forward" | "flagged" | "names", q: ResendQuota, perDay?: number): Promise<SlotClaim> {
    return this.locked(async (client) => {
      const had = await client.query(`SELECT 1 FROM resend_usage WHERE ref = $1`, [ref]);
      if (had.rowCount) return "ok";
      if (perDay !== undefined && (await usedToday(client, kind)) >= perDay) return "cap";
      if (!(await sharedRoom(client, q))) return "quota";
      await countUse(client, ref, kind);
      return "ok";
    });
  }

  /** Claim today's one "forwarding paused" alert. */
  async claimSummary(q: ResendQuota): Promise<SummaryClaim> {
    return this.locked(async (client) => {
      const day = (await client.query<{ day: string }>(`SELECT ${TODAY_UTC}::text AS day`)).rows[0]?.day ?? "";
      const had = await client.query(`SELECT 1 FROM resend_usage WHERE ref = $1`, [`summary/${day}`]);
      if (had.rowCount) return { status: "already", day };
      if (!(await sharedRoom(client, q, true))) return { status: "full", day };
      await countUse(client, `summary/${day}`, "summary");
      return { status: "claimed", day };
    });
  }

  /** The alert didn't go out: let the next held email try again. */
  async releaseSummary(day: string): Promise<void> {
    await uncountUse(this.pool, `summary/${day}`);
  }

  /** Drop what's no longer needed for replays, duplicates, or the quota. */
  async prune(): Promise<void> {
    const days = String(HOOK_ID_DAYS);
    await this.pool.query(`DELETE FROM resend_hook_ids WHERE seen_at < now() - ($1 || ' days')::interval`, [days]);
    await this.pool.query(
      `DELETE FROM inbox_mail WHERE outcome <> 'pending' AND at < now() - ($1 || ' days')::interval`,
      [days],
    );
    await pruneUsage(this.pool);
  }

  private async locked<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockMailBudget(client);
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}

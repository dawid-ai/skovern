import type pg from "pg";

// What the inbox forwarder remembers, in Postgres so every api instance and
// restart agrees: webhook IDs already handled (replays), what happened to each
// received email (the forward budget and its duplicates), and which days have
// had their "emails waiting" summary. No addresses, subjects, or bodies: Resend
// keeps the mail itself.

const MIGRATION = `
CREATE TABLE IF NOT EXISTS resend_hook_ids (
  svix_id  text PRIMARY KEY,
  seen_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS resend_hook_ids_seen ON resend_hook_ids (seen_at);
CREATE TABLE IF NOT EXISTS inbox_mail (
  email_id  text PRIMARY KEY,
  outcome   text NOT NULL CHECK (outcome IN ('forwarded', 'held', 'skipped', 'refused')),
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inbox_mail_at ON inbox_mail (at);
CREATE TABLE IF NOT EXISTS inbox_summaries (
  day      date PRIMARY KEY,
  sent_at  timestamptz NOT NULL DEFAULT now()
);
`;

/** A webhook ID is remembered this long; Svix stops retrying well before. */
export const HOOK_ID_DAYS = 7;

/** - forward: a budget slot is taken; send it.
 *  - hold: the day's budget is spent; the email stays in Resend.
 *  - duplicate: this email was already handled. */
export type Claim = "forward" | "hold" | "duplicate";

const TODAY_UTC = `(now() AT TIME ZONE 'UTC')::date`;

export class InboxStore {
  constructor(private readonly pool: pg.Pool) {}

  async migrate(): Promise<void> {
    await this.pool.query(MIGRATION);
  }

  /** Remember a webhook ID. False when it was already seen (a replay). */
  async firstSight(svixId: string): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO resend_hook_ids (svix_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [svixId],
    );
    return r.rowCount === 1;
  }

  /** Handling failed and Svix will retry: forget the ID so the retry counts. */
  async forget(svixId: string): Promise<void> {
    await this.pool.query(`DELETE FROM resend_hook_ids WHERE svix_id = $1`, [svixId]);
  }

  /** Record an email that is never forwarded (from our own domain). */
  async skip(emailId: string): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO inbox_mail (email_id, outcome) VALUES ($1, 'skipped') ON CONFLICT DO NOTHING`,
      [emailId],
    );
    return r.rowCount === 1;
  }

  /** Take a forward slot for this email, or hold it when `perDay` forwards
   *  already went out in the last 24 hours. One global lock, so two webhooks
   *  can't both take the last slot. */
  async claim(emailId: string, perDay: number): Promise<Claim> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('inbox:forward-budget'))");
      const seen = await client.query(`SELECT 1 FROM inbox_mail WHERE email_id = $1`, [emailId]);
      let claim: Claim = "duplicate";
      if (!seen.rowCount) {
        const used = await client.query<{ n: string }>(
          `SELECT count(*) AS n FROM inbox_mail WHERE outcome = 'forwarded' AND at > now() - interval '1 day'`,
        );
        claim = Number(used.rows[0]?.n ?? 0) < perDay ? "forward" : "hold";
        await client.query(`INSERT INTO inbox_mail (email_id, outcome) VALUES ($1, $2)`, [
          emailId,
          claim === "forward" ? "forwarded" : "held",
        ]);
      }
      await client.query("COMMIT");
      return claim;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /** The send failed for a reason that may pass: give the slot back so a retry can take it. */
  async release(emailId: string): Promise<void> {
    await this.pool.query(`DELETE FROM inbox_mail WHERE email_id = $1`, [emailId]);
  }

  /** Resend refused the forward for good: keep the record, free the slot. */
  async refused(emailId: string): Promise<void> {
    await this.pool.query(`UPDATE inbox_mail SET outcome = 'refused' WHERE email_id = $1`, [emailId]);
  }

  /** Claim today's (UTC) summary. Returns how many emails were held in the last
   *  24 hours, or null when today's summary was already claimed. */
  async claimSummary(): Promise<number | null> {
    const r = await this.pool.query(
      `INSERT INTO inbox_summaries (day) VALUES (${TODAY_UTC}) ON CONFLICT DO NOTHING`,
    );
    if (r.rowCount !== 1) return null;
    const held = await this.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM inbox_mail WHERE outcome = 'held' AND at > now() - interval '1 day'`,
    );
    return Number(held.rows[0]?.n ?? 0);
  }

  /** The summary didn't go out: let the next held email try again. */
  async releaseSummary(): Promise<void> {
    await this.pool.query(`DELETE FROM inbox_summaries WHERE day = ${TODAY_UTC}`);
  }

  /** Drop what's no longer needed for replays, the budget, or duplicates. */
  async prune(): Promise<void> {
    await this.pool.query(`DELETE FROM resend_hook_ids WHERE seen_at < now() - ($1 || ' days')::interval`, [String(HOOK_ID_DAYS)]);
    await this.pool.query(`DELETE FROM inbox_mail WHERE at < now() - ($1 || ' days')::interval`, [String(HOOK_ID_DAYS)]);
    await this.pool.query(`DELETE FROM inbox_summaries WHERE day < ${TODAY_UTC} - 30`);
  }
}

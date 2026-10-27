import type pg from "pg";

// Ledger resend-bounce-pause (loop 052 amendment). Resend's bounce, complaint,
// and suppression events arrive on the signed inbox webhook. When more than 5%
// of the welcome emails sent in the last 24 hours bounced, drew a complaint, or
// were suppressed (with at least 20 sent), welcome emails pause: a flood of fake
// or typo addresses must not get the skovern.com domain blocked. Only events for
// welcomes sent inside the window count, matched by Resend's email ID. Signups
// are still saved; the pause lifts by itself as the window moves on.

export const FEEDBACK_MIGRATION = `
CREATE TABLE IF NOT EXISTS mail_feedback (
  email_id  text NOT NULL,
  kind      text NOT NULL,
  tag       text,
  at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (email_id, kind)
);
CREATE INDEX IF NOT EXISTS mail_feedback_at ON mail_feedback (at);
ALTER TABLE mail_feedback DROP CONSTRAINT IF EXISTS mail_feedback_kind_check;
ALTER TABLE mail_feedback ADD CONSTRAINT mail_feedback_kind_check CHECK (kind IN ('bounced', 'complained', 'suppressed'));
`;

export const BOUNCE_PAUSE = { minSends: 20, maxRate: 0.05 } as const;

export type FeedbackKind = "bounced" | "complained" | "suppressed";

/** Record one bounce, complaint, or suppression. `tag` is the email's `kind`
 *  tag, kept for reading the table; the pause matches on the email ID. */
export async function recordFeedback(
  db: pg.Pool,
  emailId: string,
  kind: FeedbackKind,
  tag: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO mail_feedback (email_id, kind, tag) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [emailId.slice(0, 200), kind, tag?.slice(0, 64) ?? null],
  );
}

export interface BounceStats {
  sends: number;
  /** Welcomes sent in the window that bounced, drew a complaint, or were
   *  suppressed (each counted once). */
  bad: number;
}

export async function welcomeBounceStats(db: pg.PoolClient | pg.Pool): Promise<BounceStats> {
  const r = await db.query<{ sends: string; bad: string }>(
    `SELECT (SELECT count(*) FROM waitlist_welcome_sends WHERE sent_at > now() - interval '1 day') AS sends,
            (SELECT count(DISTINCT f.email_id) FROM mail_feedback f
               JOIN waitlist_welcome_sends s ON s.resend_id = f.email_id
              WHERE s.sent_at > now() - interval '1 day') AS bad`,
  );
  return { sends: Number(r.rows[0]?.sends ?? 0), bad: Number(r.rows[0]?.bad ?? 0) };
}

export function bouncePaused(s: BounceStats): boolean {
  return s.sends >= BOUNCE_PAUSE.minSends && s.bad / s.sends > BOUNCE_PAUSE.maxRate;
}

/** One log line while paused, at most every 10 minutes per process. */
let lastPausedLog = 0;
export function logWelcomesPaused(s: BounceStats, now: number = Date.now()): void {
  if (now - lastPausedLog < 10 * 60_000) return;
  lastPausedLog = now;
  const pct = Math.round((s.bad / s.sends) * 1000) / 10;
  console.warn(`[waitlist] welcome emails paused: ${s.bad} of ${s.sends} bounced, complained, or were suppressed in 24 hours (${pct}%)`);
}

/** Test seam: let the next paused line through. */
export function resetPausedLog(): void {
  lastPausedLog = 0;
}

import type pg from "pg";
import { WELCOME_TAG } from "./mail.js";

// Ledger resend-bounce-pause (loop 052 amendment). Resend's bounce and
// complaint events arrive on the signed inbox webhook. When more than 5% of the
// welcome emails sent in the last 24 hours bounced or were marked as spam (with
// at least 20 sent), welcome emails pause: a flood of fake or typo addresses
// must not get the skovern.com domain blocked. Signups are still saved; the
// pause lifts by itself as the 24-hour window moves on.

export const FEEDBACK_MIGRATION = `
CREATE TABLE IF NOT EXISTS mail_feedback (
  email_id  text NOT NULL,
  kind      text NOT NULL CHECK (kind IN ('bounced', 'complained')),
  tag       text,
  at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (email_id, kind)
);
CREATE INDEX IF NOT EXISTS mail_feedback_at ON mail_feedback (at);
`;

export const BOUNCE_PAUSE = { minSends: 20, maxRate: 0.05 } as const;

export type FeedbackKind = "bounced" | "complained";

/** Record one bounce or complaint. `tag` is the email's `kind` tag
 *  ("welcome", "forward", or null for untagged mail like sign-in links). */
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
  /** Welcome emails that bounced or drew a complaint (each counted once). */
  bad: number;
}

export async function welcomeBounceStats(db: pg.PoolClient | pg.Pool): Promise<BounceStats> {
  const r = await db.query<{ sends: string; bad: string }>(
    `SELECT (SELECT count(*) FROM waitlist_welcome_sends WHERE sent_at > now() - interval '1 day') AS sends,
            (SELECT count(DISTINCT email_id) FROM mail_feedback
              WHERE tag = $1 AND at > now() - interval '1 day') AS bad`,
    [WELCOME_TAG],
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
  console.warn(`[waitlist] welcome emails paused: ${s.bad} of ${s.sends} bounced or complained in 24 hours (${pct}%)`);
}

/** Test seam: let the next paused line through. */
export function resetPausedLog(): void {
  lastPausedLog = 0;
}

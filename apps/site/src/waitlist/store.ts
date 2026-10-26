import { randomBytes } from "node:crypto";
import type pg from "pg";
import { sha256 } from "../auth/tokens.js";
import type { BusinessType } from "./validate.js";
import {
  claimWelcome,
  DEFAULT_WELCOME_BUDGET,
  WELCOME_BUDGET_MIGRATION,
  WELCOME_COOLDOWN_HOURS,
  type WelcomeBudget,
} from "./welcome-budget.js";

type Pool = pg.Pool;

// The waitlist: its own table and its own number sequence. The number is a
// place in line, NOT the founding-user number (accounts.og_number), which only
// starts at the open beta. Tokens (details + remove) are 32 random bytes handed
// to the person; only their SHA-256 is stored, so a database leak yields no
// usable link.
const MIGRATION = `
CREATE SEQUENCE IF NOT EXISTS skovern_waitlist_seq START 1;

CREATE TABLE IF NOT EXISTS waitlist (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            text NOT NULL UNIQUE,
  name             text NOT NULL,
  number           bigint NOT NULL UNIQUE DEFAULT nextval('skovern_waitlist_seq'),
  job_title        text,
  business_type    text,
  url              text,
  welcome_sent_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS waitlist_tokens (
  token_hash   text PRIMARY KEY,
  waitlist_id  uuid NOT NULL REFERENCES waitlist(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  expires_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS waitlist_tokens_expiry ON waitlist_tokens (expires_at) WHERE expires_at IS NOT NULL;
-- Token kinds: details (step 2 on the first join), decoy (what a repeat join
-- gets: accepted, writes nothing), remove (the email's leave link).
ALTER TABLE waitlist_tokens DROP CONSTRAINT IF EXISTS waitlist_tokens_kind_check;
ALTER TABLE waitlist_tokens ADD CONSTRAINT waitlist_tokens_kind_check CHECK (kind IN ('details', 'decoy', 'remove'));
`;

export const DETAILS_TTL_HOURS = 24;

type TokenKind = "details" | "decoy" | "remove";

export interface WaitlistEntry {
  number: number;
  name: string;
  email: string;
  jobTitle: string | null;
  businessType: string | null;
  url: string | null;
  createdAt: string;
}

export interface JoinResult {
  id: string;
  number: number;
  /** Set when this join claimed the welcome email (due and within budget):
   *  the budget log row, handed back to releaseWelcome if the send fails. */
  welcomeClaim: string | null;
  /** True when this join added the person (false for a repeat). */
  created: boolean;
}

/** A saved signup whose welcome is claimed and ready to send. */
export interface WelcomeJob {
  id: string;
  email: string;
  name: string;
  number: number;
  claim: string;
}

export function newToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: sha256(raw) };
}

export class WaitlistStore {
  constructor(
    private readonly pool: Pool,
    private readonly budget: WelcomeBudget = DEFAULT_WELCOME_BUDGET,
  ) {}

  async migrate(): Promise<void> {
    await this.pool.query(MIGRATION);
    await this.pool.query(WELCOME_BUDGET_MIGRATION);
  }

  /** Add the person, or find them. The number is drawn once and never changes;
   *  same-email joins are serialized so the sequence never skips a value.
   *  The welcome email is CLAIMED inside the same lock (welcome_sent_at set
   *  now), so two simultaneous joins can't both send it. If the send then
   *  fails, call releaseWelcome to hand the claim back. */
  async join(email: string, name: string): Promise<JoinResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('waitlist:' || $1))", [email]);
      const found = await client.query<{ id: string; number: string; due: boolean }>(
        `SELECT id, number,
                (welcome_sent_at IS NULL OR welcome_sent_at < now() - ($2 || ' hours')::interval) AS due
           FROM waitlist WHERE email = $1`,
        [email, String(WELCOME_COOLDOWN_HOURS)],
      );
      let row = found.rows[0];
      let created = false;
      if (!row) {
        const inserted = await client.query<{ id: string; number: string }>(
          `INSERT INTO waitlist (email, name) VALUES ($1, $2) RETURNING id, number`,
          [email, name],
        );
        const ins = inserted.rows[0];
        if (!ins) throw new Error("waitlist insert failed");
        row = { ...ins, due: true };
        created = true;
      }
      // Only a due welcome takes the (global) budget lock; repeats skip it.
      const claim = row.due ? await claimWelcome(client, row.id, this.budget) : null;
      await client.query("COMMIT");
      return { id: row.id, number: Number(row.number), welcomeClaim: claim, created };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /** The welcome send failed: give the claim and its budget slot back, so the
   *  backlog sender (or the next join) retries it. */
  async releaseWelcome(id: string, claim: string): Promise<void> {
    await this.pool.query(`UPDATE waitlist SET welcome_sent_at = NULL WHERE id = $1`, [id]);
    await this.pool.query(`DELETE FROM waitlist_welcome_sends WHERE id = $1`, [claim]);
  }

  /** Claim the oldest signup still waiting for its welcome, if the budget has
   *  room. Null when nothing waits or the budget is spent. */
  async claimBacklog(): Promise<WelcomeJob | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const next = await client.query<{ id: string; email: string; name: string; number: string }>(
        `SELECT id, email, name, number FROM waitlist WHERE welcome_sent_at IS NULL
          ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      const row = next.rows[0];
      const claim = row ? await claimWelcome(client, row.id, this.budget) : null;
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

  /** Mint a token for this person. Details and decoy tokens expire; remove
   *  tokens last until the person leaves (the cascade deletes them then). */
  async issueToken(id: string, kind: TokenKind): Promise<string> {
    const t = newToken();
    await this.pool.query(
      `INSERT INTO waitlist_tokens (token_hash, waitlist_id, kind, expires_at)
       VALUES ($1, $2, $3, CASE WHEN $3 = 'remove' THEN NULL ELSE now() + ($4 || ' hours')::interval END)`,
      [t.hash, id, kind, String(DETAILS_TTL_HOURS)],
    );
    return t.raw;
  }

  private async resolve(raw: string, kinds: TokenKind[]): Promise<{ id: string; kind: TokenKind } | null> {
    const r = await this.pool.query<{ waitlist_id: string; kind: TokenKind }>(
      `SELECT waitlist_id, kind FROM waitlist_tokens
        WHERE token_hash = $1 AND kind = ANY($2) AND (expires_at IS NULL OR expires_at > now())`,
      [sha256(raw), kinds],
    );
    const row = r.rows[0];
    return row ? { id: row.waitlist_id, kind: row.kind } : null;
  }

  /** Save the optional step-2 answers. False when the token is unknown or expired.
   *  A decoy token (from a repeat join) is accepted and writes nothing: anyone
   *  who knows an address can join again with it. Only empty fields are filled,
   *  as a second guard. */
  async saveDetails(
    raw: string,
    d: { jobTitle: string | null; businessType: BusinessType | null; url: string | null },
  ): Promise<boolean> {
    const token = await this.resolve(raw, ["details", "decoy"]);
    if (!token) return false;
    if (token.kind === "decoy") return true;
    const id = token.id;
    await this.pool.query(
      `UPDATE waitlist
          SET job_title = COALESCE(job_title, $2),
              business_type = COALESCE(business_type, $3),
              url = COALESCE(url, $4)
        WHERE id = $1`,
      [id, d.jobTitle, d.businessType, d.url],
    );
    return true;
  }

  /** Is this a live remove link? (Used by the GET confirm page; deletes nothing.) */
  async canRemove(raw: string): Promise<boolean> {
    return (await this.resolve(raw, ["remove"])) !== null;
  }

  /** Delete the person and every token they hold. False when the link is dead. */
  async remove(raw: string): Promise<boolean> {
    const token = await this.resolve(raw, ["remove"]);
    if (!token) return false;
    await this.pool.query(`DELETE FROM waitlist WHERE id = $1`, [token.id]);
    return true;
  }

  /** The next number a real signup would get, for the honeypot's fake reply. */
  async plausibleNumber(): Promise<number> {
    const r = await this.pool.query<{ n: string }>(`SELECT COALESCE(MAX(number), 0) + 1 AS n FROM waitlist`);
    return Number(r.rows[0]?.n ?? 1);
  }

  async list(): Promise<WaitlistEntry[]> {
    const r = await this.pool.query<{
      number: string;
      name: string;
      email: string;
      job_title: string | null;
      business_type: string | null;
      url: string | null;
      created_at: Date;
    }>(`SELECT number, name, email, job_title, business_type, url, created_at FROM waitlist ORDER BY number`);
    return r.rows.map((x) => ({
      number: Number(x.number),
      name: x.name,
      email: x.email,
      jobTitle: x.job_title,
      businessType: x.business_type,
      url: x.url,
      createdAt: x.created_at.toISOString(),
    }));
  }
}

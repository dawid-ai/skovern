import pg from "pg";
import { secretMatches, sha256 } from "./tokens.js";

const { Pool } = pg;
export type Pool = pg.Pool;

// A fixed hash of the same length as a real one, compared against on a token
// miss so the constant-time path runs whether or not the id existed.
const DUMMY_SECRET_HASH = sha256("deskhand/no-such-token");

type AccountRow = { id: string; og_number: string; email: string };

// One migration, applied idempotently. A dedicated migration tool is overkill
// for three tables; when the cloud schema grows past a handful, swap this for
// node-pg-migrate.
const MIGRATION = `
CREATE SEQUENCE IF NOT EXISTS deskhand_og_seq START 1;

CREATE TABLE IF NOT EXISTS accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,
  og_number   bigint NOT NULL UNIQUE DEFAULT nextval('deskhand_og_seq'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS magic_tokens (
  id           text PRIMARY KEY,
  secret_hash  text NOT NULL,
  email        text NOT NULL,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id           text PRIMARY KEY,
  secret_hash  text NOT NULL,
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
`;

export interface Account {
  id: string;
  ogNumber: number;
  email: string;
}

export class AuthStore {
  constructor(private readonly pool: Pool) {}

  async migrate(): Promise<void> {
    await this.pool.query(MIGRATION);
  }

  async insertMagicToken(t: {
    id: string;
    secretHash: string;
    email: string;
    ttlMinutes: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO magic_tokens (id, secret_hash, email, expires_at)
       VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)`,
      [t.id, t.secretHash, t.email, String(t.ttlMinutes)],
    );
  }

  /**
   * Consume a magic token if it is valid (found, unexpired, unconsumed, and the
   * secret matches). Returns the email it was issued to, or null. Single-use is
   * enforced atomically: a wrong secret never burns the token, and two
   * simultaneous verifies of the same token yield at most one success.
   */
  async consumeMagicToken(id: string, secret: string): Promise<string | null> {
    const found = await this.pool.query<{ secret_hash: string }>(
      `SELECT secret_hash FROM magic_tokens
        WHERE id = $1 AND consumed_at IS NULL AND expires_at > now()`,
      [id],
    );
    const row = found.rows[0];
    // Always run the constant-time compare — on a miss, against a dummy hash —
    // so app-level timing never reveals whether the id existed.
    const ok = secretMatches(secret, row?.secret_hash ?? DUMMY_SECRET_HASH);
    if (!row || !ok) return null;

    const consumed = await this.pool.query<{ email: string }>(
      `UPDATE magic_tokens SET consumed_at = now()
        WHERE id = $1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING email`,
      [id],
    );
    return consumed.rows[0]?.email ?? null;
  }

  /** Create the account for this email, or return the existing one. The OG
   * number is assigned once, on first insert, and never changes. */
  async upsertAccount(email: string): Promise<Account> {
    // A plain INSERT ... ON CONFLICT would evaluate og_number's DEFAULT
    // nextval before the conflict is resolved, so a concurrent same-email
    // sign-in would burn a sequence value and leave a gap. We instead serialize
    // same-email sign-ins with a per-email advisory lock and only INSERT after
    // confirming no row exists — so nextval fires exactly once per account.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [email]);
      const existing = await client.query<AccountRow>(
        `SELECT id, og_number, email FROM accounts WHERE email = $1`,
        [email],
      );
      const row =
        existing.rows[0] ??
        (
          await client.query<AccountRow>(
            `INSERT INTO accounts (email) VALUES ($1) RETURNING id, og_number, email`,
            [email],
          )
        ).rows[0];
      await client.query("COMMIT");
      if (!row) throw new Error("account upsert failed");
      return { id: row.id, ogNumber: Number(row.og_number), email: row.email };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async createSession(
    accountId: string,
    session: { id: string; secretHash: string },
    ttlDays: number,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions (id, secret_hash, account_id, expires_at)
       VALUES ($1, $2, $3, now() + ($4 || ' days')::interval)`,
      [session.id, session.secretHash, accountId, String(ttlDays)],
    );
  }

  /**
   * Resolve a session token to its account id if it's live (found, unexpired,
   * secret matches). Same constant-time discipline as consumeMagicToken: the
   * compare always runs, against a dummy hash on a miss, so timing never
   * reveals whether the session id existed.
   */
  async validateSession(
    id: string,
    secret: string,
  ): Promise<{ accountId: string; email: string } | null> {
    const found = await this.pool.query<{ secret_hash: string; account_id: string; email: string }>(
      `SELECT s.secret_hash, s.account_id, a.email
         FROM sessions s JOIN accounts a ON a.id = s.account_id
        WHERE s.id = $1 AND s.expires_at > now()`,
      [id],
    );
    const row = found.rows[0];
    const ok = secretMatches(secret, row?.secret_hash ?? DUMMY_SECRET_HASH);
    if (!row || !ok) return null;
    return { accountId: row.account_id, email: row.email };
  }
}

import type pg from "pg";

type Pool = pg.Pool;

export type Sender = "user" | "founder";

// Own migration, kept apart from auth/news. main.ts runs migrate() on boot,
// AFTER AuthStore.migrate() — so `accounts` exists for the ALTER below.
const MIGRATION = `
CREATE TABLE IF NOT EXISTS dm_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- loop 010: direction + per-account read marker (idempotent).
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS sender text NOT NULL DEFAULT 'user';
ALTER TABLE accounts    ADD COLUMN IF NOT EXISTS dm_last_read_at timestamptz;
`;

/** A message in the founder's cross-user admin view. */
export interface AdminDmMessage {
  id: string;
  accountId: string;
  email: string;
  sender: Sender;
  body: string;
  createdAt: string;
}

/** One turn in a single user's conversation. */
export interface ThreadMessage {
  sender: Sender;
  body: string;
  createdAt: string;
}

export interface Thread {
  messages: ThreadMessage[];
  /** Founder replies this account hasn't seen yet. */
  unread: number;
}

type AdminRow = { id: string; account_id: string; email: string; sender: Sender; body: string; created_at: Date };
type ThreadRow = { sender: Sender; body: string; created_at: Date };

export class DmStore {
  constructor(private readonly pool: Pool) {}

  async migrate(): Promise<void> {
    await this.pool.query(MIGRATION);
  }

  async insert(accountId: string, body: string, sender: Sender = "user"): Promise<void> {
    await this.pool.query(`INSERT INTO dm_messages (account_id, body, sender) VALUES ($1, $2, $3)`, [
      accountId,
      body,
      sender,
    ]);
  }

  /** One account's conversation, oldest-first, plus its unseen-reply count. */
  async thread(accountId: string, limit = 500): Promise<Thread> {
    const messages = await this.pool.query<ThreadRow>(
      `SELECT sender, body, created_at FROM dm_messages
        WHERE account_id = $1 ORDER BY created_at ASC LIMIT $2`,
      [accountId, limit],
    );
    const unread = await this.pool.query<{ unread: number }>(
      `SELECT count(*)::int AS unread FROM dm_messages m
         JOIN accounts a ON a.id = m.account_id
        WHERE m.account_id = $1 AND m.sender = 'founder'
          AND (a.dm_last_read_at IS NULL OR m.created_at > a.dm_last_read_at)`,
      [accountId],
    );
    return {
      messages: messages.rows.map((r) => ({
        sender: r.sender,
        body: r.body,
        createdAt: r.created_at.toISOString(),
      })),
      unread: unread.rows[0]?.unread ?? 0,
    };
  }

  /** Mark all of this account's founder replies as seen (up to now). */
  async markRead(accountId: string): Promise<void> {
    await this.pool.query(`UPDATE accounts SET dm_last_read_at = now() WHERE id = $1`, [accountId]);
  }

  /** The founder's cross-user admin view, newest first. Explicit columns. */
  async list(limit = 200): Promise<AdminDmMessage[]> {
    const { rows } = await this.pool.query<AdminRow>(
      `SELECT m.id, m.account_id, a.email, m.sender, m.body, m.created_at
         FROM dm_messages m
         JOIN accounts a ON a.id = m.account_id
        ORDER BY m.created_at DESC
        LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      email: r.email,
      sender: r.sender,
      body: r.body,
      createdAt: r.created_at.toISOString(),
    }));
  }
}

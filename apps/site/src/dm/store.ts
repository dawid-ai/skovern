import type pg from "pg";

type Pool = pg.Pool;

// Own migration, kept apart from auth/news. main.ts runs migrate() on boot.
const MIGRATION = `
CREATE TABLE IF NOT EXISTS dm_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
`;

export interface DmMessage {
  id: string;
  email: string;
  body: string;
  createdAt: string;
}

type MessageRow = { id: string; email: string; body: string; created_at: Date };

export class DmStore {
  constructor(private readonly pool: Pool) {}

  async migrate(): Promise<void> {
    await this.pool.query(MIGRATION);
  }

  async insert(accountId: string, body: string): Promise<void> {
    await this.pool.query(`INSERT INTO dm_messages (account_id, body) VALUES ($1, $2)`, [
      accountId,
      body,
    ]);
  }

  /** The whole thread for the founder's admin view, newest first. Joins the
   *  sender's email; selects an explicit column list, never *. */
  async list(limit = 200): Promise<DmMessage[]> {
    const { rows } = await this.pool.query<MessageRow>(
      `SELECT m.id, a.email, m.body, m.created_at
         FROM dm_messages m
         JOIN accounts a ON a.id = m.account_id
        ORDER BY m.created_at DESC
        LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      body: r.body,
      createdAt: r.created_at.toISOString(),
    }));
  }
}

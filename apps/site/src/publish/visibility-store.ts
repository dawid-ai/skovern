import { randomUUID } from "node:crypto";
import type pg from "pg";

type Pool = pg.Pool;

// User-published AI Visibility results. Its own table + migration (kept apart from
// news/auth) so schemas don't tangle. Unlike news (admin-authored), these are
// written by signed-in users — so the handler validates hard before we get here,
// and we still cap defensively. account_id is stored for ownership but NEVER
// exposed on the public page.
const MIGRATION = `
CREATE TABLE IF NOT EXISTS published_visibility (
  id           text PRIMARY KEY,
  account_id   text NOT NULL,
  business     text NOT NULL,
  score        integer NOT NULL,
  competitors  jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
`;

export interface PublishedVisibility {
  id: string;
  business: string;
  score: number;
  competitors: string[];
  createdAt: string;
}

type Row = { id: string; business: string; score: number; competitors: unknown; created_at: Date };

const MAX_BUSINESS = 120;
const MAX_COMPETITORS = 10;
const MAX_COMPETITOR_LEN = 80;

export class VisibilityStore {
  constructor(private readonly pool: Pool) {}

  async migrate(): Promise<void> {
    await this.pool.query(MIGRATION);
  }

  /** Store a user's result and return its public id. Inputs are clamped here as
   *  a last line of defence even though the handler already validated them. */
  async create(input: {
    accountId: string;
    business: string;
    score: number;
    competitors: string[];
  }): Promise<string> {
    const id = randomUUID();
    const business = input.business.trim().slice(0, MAX_BUSINESS);
    const score = Math.max(0, Math.min(100, Math.round(input.score)));
    const competitors = input.competitors
      .filter((c) => typeof c === "string")
      .map((c) => c.trim().slice(0, MAX_COMPETITOR_LEN))
      .filter(Boolean)
      .slice(0, MAX_COMPETITORS);
    await this.pool.query(
      `INSERT INTO published_visibility (id, account_id, business, score, competitors)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [id, input.accountId, business, score, JSON.stringify(competitors)],
    );
    return id;
  }

  /** One published result for its public page, or null. No account_id — public columns only. */
  async getById(id: string): Promise<PublishedVisibility | null> {
    const { rows } = await this.pool.query<Row>(
      `SELECT id, business, score, competitors, created_at FROM published_visibility WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      business: row.business,
      score: row.score,
      competitors: Array.isArray(row.competitors) ? (row.competitors as string[]) : [],
      createdAt: row.created_at.toISOString(),
    };
  }
}

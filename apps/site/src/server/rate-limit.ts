// Per-key fixed-window rate limiter, in memory (one api replica). Keys are
// `<bucket>:<client ip>`. The map is pruned as windows expire and hard-capped,
// so a spray of spoofed addresses can't grow memory without bound.

export interface Limit {
  max: number;
  windowMs: number;
}

const MAX_KEYS = 50_000;

export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Count one hit; returns false when this key is over its limit. */
  take(key: string, limit: Limit): boolean {
    const t = this.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      if (this.hits.size >= MAX_KEYS) this.prune(t);
      // why: after pruning, a still-full map means a flood of live keys. Evict the
      // oldest insertion rather than refusing everyone.
      if (this.hits.size >= MAX_KEYS) {
        const oldest = this.hits.keys().next().value;
        if (oldest !== undefined) this.hits.delete(oldest);
      }
      this.hits.set(key, { count: 1, resetAt: t + limit.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit.max;
  }

  /** Seconds until this key's window resets (for Retry-After). */
  retryAfter(key: string): number {
    const entry = this.hits.get(key);
    return entry ? Math.max(1, Math.ceil((entry.resetAt - this.now()) / 1000)) : 1;
  }

  prune(t: number = this.now()): void {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }

  get size(): number {
    return this.hits.size;
  }
}

/** The public limits. Signups are rare per person; these stop scripted floods. */
export const LIMITS = {
  waitlist: { max: 3, windowMs: 10 * 60_000 },
  waitlistDetails: { max: 20, windowMs: 10 * 60_000 },
  waitlistRemove: { max: 20, windowMs: 10 * 60_000 },
  authRequest: { max: 6, windowMs: 10 * 60_000 },
} satisfies Record<string, Limit>;

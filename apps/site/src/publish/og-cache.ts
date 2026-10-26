// A small in-memory LRU for rendered share cards (ledger og-png-endpoint-caching).
// Published visibility results are immutable, so a card keyed by id never goes
// stale. Rendering one costs satori + resvg (tens of ms of CPU); a scraper
// burst on a shared link would otherwise pin the CPU.

export class LruCache<V> {
  private readonly map = new Map<string, V>();

  constructor(private readonly max: number) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      // Re-insert to mark as most recently used.
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

/** About 60 KB per card, so 200 cards stay around 12 MB. */
export const ogCards = new LruCache<Buffer>(200);

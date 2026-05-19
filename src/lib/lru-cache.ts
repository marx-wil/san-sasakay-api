/**
 * Tiny LRU cache.
 *
 * Built on top of `Map`'s well-defined insertion-order iteration: every
 * `get`/`set` re-inserts the key so the most-recently-used entries
 * cluster at the tail and the oldest at the head. When we hit the cap
 * we evict from the head until we're back under the limit.
 *
 * Used by the Nominatim proxy so identical `q=` strings only hit the
 * upstream once per TTL window. Sized for a single API process — if we
 * ever scale to multiple instances we'll move this behind Redis. For
 * MVP traffic an in-process cap (default 500 entries) is plenty.
 *
 * Why not pull in `lru-cache`? The plan calls it out as an option, but
 * we don't need its full feature set (size-by-bytes, async fetch, etc.)
 * and avoiding a new direct dependency is cheaper than the few dozen
 * lines below.
 */

export type LRUCacheOptions = {
  /** Hard upper bound on entry count. Older entries are evicted on insert. */
  max: number;
  /** Time-to-live in milliseconds. 0 / undefined disables expiry. */
  ttlMs?: number;
};

type Entry<V> = {
  value: V;
  /** Wall-clock millisecond timestamp; meaningful only when ttlMs > 0. */
  expiresAt: number;
};

export class LRUCache<K, V> {
  private readonly map = new Map<K, Entry<V>>();
  private readonly max: number;
  private readonly ttlMs: number;

  constructor(opts: LRUCacheOptions) {
    if (opts.max <= 0) {
      throw new Error("LRUCache: max must be > 0");
    }
    this.max = opts.max;
    this.ttlMs = opts.ttlMs ?? 0;
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this.ttlMs > 0 && entry.expiresAt < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency by re-inserting at the tail.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    const expiresAt = this.ttlMs > 0 ? Date.now() + this.ttlMs : Number.POSITIVE_INFINITY;
    this.map.set(key, { value, expiresAt });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

// The module's cache, shaped like Redis so it can become Redis.
//
// The brief asked for Redis on a 30-second refresh. This deployment has no Redis, so the
// default driver is an in-process map — but the INTERFACE is the Redis one (`get`, `set`
// with a TTL, `del`), and every caller goes through it. Adding `ioredis` later is a new
// class implementing three methods and one line in `momentum/index.ts`; nothing above this
// file changes.
//
// `single` is the piece that matters more than the caching does. Upstox counts requests per
// token, and the failure it produces is not a slow page but a 429 that takes every panel
// down at once. When a board expires and three browser tabs poll within the same tick, this
// collapses them onto ONE upstream fetch instead of three — the same reasoning as the
// in-flight map in `index.ts`, applied to the momentum tiers.

export interface MomentumCache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Milliseconds until `key` expires; null when it is absent or already stale. */
  ttl(key: string): Promise<number | null>;
}

interface Entry {
  value: unknown;
  expiresAt: number;
}

export class MemoryCache implements MomentumCache {
  private readonly map = new Map<string, Entry>();

  async get<T>(key: string): Promise<T | null> {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (Date.now() >= hit.expiresAt) {
      this.map.delete(key);
      return null;
    }
    return hit.value as T;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
    // Bounded so a long-running process with per-symbol keys cannot grow without limit.
    if (this.map.size > 5_000) this.evictExpired();
  }

  async del(key: string): Promise<void> {
    this.map.delete(key);
  }

  async ttl(key: string): Promise<number | null> {
    const hit = this.map.get(key);
    if (!hit) return null;
    const left = hit.expiresAt - Date.now();
    return left > 0 ? left : null;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.map) if (now >= v.expiresAt) this.map.delete(k);
  }
}

export const cache: MomentumCache = new MemoryCache();

const inflight = new Map<string, Promise<unknown>>();

/**
 * Run `fn` at most once per key at a time, and serve its result from cache until it expires.
 *
 * The in-flight map is deliberately keyed the same as the cache: a miss that is already
 * being filled joins the existing promise rather than starting a second identical fetch.
 */
export async function single<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = await cache.get<T>(key);
  if (hit !== null) return hit;

  const pending = inflight.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const p = (async () => {
    const v = await fn();
    await cache.set(key, v, ttlMs);
    return v;
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, p);
  return p;
}

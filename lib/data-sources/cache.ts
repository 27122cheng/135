/**
 * In-memory TTL cache with a stale tier.
 *
 * Two lifetimes per entry: `expiresAt` (after which the value is no longer
 * fresh) and `staleUntil` (after which it is dropped entirely). Between the
 * two, the value is still returned — but only via getStale(), and only to
 * callers that then label it as stale. That tier exists so a source that has
 * hit its free-tier quota can answer with its last real response instead of a
 * fabricated one; see free-source.ts.
 *
 * Serverless instances are ephemeral, so this reduces duplicate calls within a
 * warm instance rather than enforcing anything globally.
 */

interface CacheEntry<T> {
  value: T;
  storedAt: number;
  expiresAt: number;
  staleUntil: number;
}

const store = new Map<string, CacheEntry<unknown>>();

/** How long past its TTL a value stays servable as stale. */
export const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;

export function getCached<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  const now = Date.now();
  if (now > entry.staleUntil) {
    store.delete(key);
    return undefined;
  }
  if (now > entry.expiresAt) return undefined;
  return entry.value as T;
}

/**
 * Returns an expired-but-not-yet-dropped value with its age, or undefined.
 * The age matters: callers must tell the user how old the data they are
 * looking at actually is.
 */
export function getStale<T>(key: string): { value: T; ageMs: number } | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  const now = Date.now();
  if (now > entry.staleUntil) {
    store.delete(key);
    return undefined;
  }
  return { value: entry.value as T, ageMs: now - entry.storedAt };
}

export function setCached<T>(key: string, value: T, ttlMs: number, staleMs = DEFAULT_STALE_MS): void {
  const now = Date.now();
  store.set(key, {
    value,
    storedAt: now,
    expiresAt: now + ttlMs,
    staleUntil: now + ttlMs + staleMs,
  });
}

/** Only caches successful (non-null) results so failures are retried. */
export async function cachedOrFetch<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T | null>,
): Promise<T | null> {
  const cached = getCached<T>(key);
  if (cached !== undefined) return cached;
  const value = await fn();
  if (value !== null) setCached(key, value, ttlMs);
  return value;
}

/** Test seam — clears every entry. */
export function __resetCacheForTests(): void {
  store.clear();
}

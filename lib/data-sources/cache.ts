/**
 * In-memory TTL cache + per-source daily rate-limit guard.
 * Serverless instances are ephemeral so this is a best-effort protection
 * layer (reduces duplicate calls within a warm instance), not a hard quota.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

export function getCached<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function setCached<T>(key: string, value: T, ttlMs: number): void {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
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

interface DailyCounter {
  day: string;
  count: number;
}

const dailyCounters = new Map<string, DailyCounter>();

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Returns true and consumes one call if `source` is still under
 * `dailyLimit` for today (UTC); returns false once exhausted.
 */
export function checkRateLimit(source: string, dailyLimit: number): boolean {
  const today = utcDay();
  const entry = dailyCounters.get(source);
  if (!entry || entry.day !== today) {
    dailyCounters.set(source, { day: today, count: 1 });
    return true;
  }
  if (entry.count >= dailyLimit) return false;
  entry.count += 1;
  return true;
}

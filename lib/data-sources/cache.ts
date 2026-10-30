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

/**
 * The stale window for *candle series*, deliberately much longer.
 *
 * The default 24 hours is right for most sources — yesterday's news query or
 * yield print is a different answer — and it is what turned one upstream
 * outage into a blind system. XAUUSD's proxy and Stooq both failed for over a
 * day; the moment the last good candle series crossed the 24-hour line, every
 * timeframe reported 「無可用快取」at once and ATR, the technical read and the
 * structure zones all went down with it. A daily series missing its newest
 * bar still carries ~99% of what ATR(14), EMA200 and the swing structure are
 * computed from. A week is where that stops being true — beyond it the
 * structure zones themselves have plausibly moved — so a week is the window,
 * and the card labels the age whenever the stale tier answers. Quotes are the
 * opposite case and keep their tight windows: an old price is not a price.
 */
export const CANDLE_STALE_MS = 7 * 24 * 60 * 60 * 1000;

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

/**
 * 不讓記憶體快取無上限長大.
 *
 * Entries were only ever dropped when something read them past their stale
 * window; a key nobody asks for again (a date-keyed calendar lookup, a
 * one-off symbol search) stayed forever. On a serverless instance that is
 * moot — the instance dies first. On a PC acting as the host it is a slow
 * leak: small per day, never reclaimed, and a long-running process has
 * nothing else to blame. Every SWEEP_EVERY writes, expired entries are
 * swept; past MAX_ENTRIES the oldest go first.
 */
export const MAX_ENTRIES = 2000;
const SWEEP_EVERY = 50;
let writes = 0;

function sweep(now: number): void {
  for (const [key, entry] of store) {
    if (now > entry.staleUntil) store.delete(key);
  }
  if (store.size > MAX_ENTRIES) {
    const oldest = [...store.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt);
    for (const [key] of oldest.slice(0, store.size - MAX_ENTRIES)) store.delete(key);
  }
}

export function setCached<T>(key: string, value: T, ttlMs: number, staleMs = DEFAULT_STALE_MS): void {
  const now = Date.now();
  store.set(key, {
    value,
    storedAt: now,
    expiresAt: now + ttlMs,
    staleUntil: now + ttlMs + staleMs,
  });
  if (++writes % SWEEP_EVERY === 0 || store.size > MAX_ENTRIES) sweep(now);
}

/** For diagnostics: how many entries the memory tier holds right now. */
export function cacheSize(): number {
  return store.size;
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

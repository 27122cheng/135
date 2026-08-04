import { DEFAULT_STALE_MS, getCached, getStale, setCached } from "./cache";
import { recordFailure, recordSuccess, tryConsume, type QuotaLimit } from "./quota";

/**
 * The one way every free-tier source is called.
 *
 * The spec's hard requirement: track quota, back off exponentially, and when
 * over budget return the last cached result **marked stale** — never a fake
 * value, never a random fill. Centralising it here is what makes that true for
 * all sources at once instead of nine places that each have to remember.
 *
 * Order of preference, strongest to weakest:
 *   1. fresh cache               — free, current
 *   2. live call                 — costs quota
 *   3. stale cache, labelled     — old but real
 *   4. null + a data_gap         — honest nothing
 *
 * There is no fifth option. A caller that gets null must degrade the signal,
 * not invent a number.
 */

export interface FreeFetchResult<T> {
  value: T;
  /** True when the value came from cache past its TTL. */
  stale: boolean;
  /** Age of the value in ms; 0 for a fresh live call. */
  ageMs: number;
}

export interface FreeFetchOptions<T> {
  /** Quota bucket — share one name across all calls that spend the same budget. */
  source: string;
  /** Human-readable name used in data_gaps messages. */
  label: string;
  /** Cache key; must vary with every parameter that changes the response. */
  key: string;
  ttlMs: number;
  limit: QuotaLimit;
  /** Gap messages are appended here, including the stale notice. */
  gaps: string[];
  /** Returns null on any failure; must not throw. */
  fn: () => Promise<T | null>;
  staleMs?: number;
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} 分鐘`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} 小時` : `${Math.round(h / 24)} 天`;
}

export async function fetchFree<T>(opts: FreeFetchOptions<T>): Promise<FreeFetchResult<T> | null> {
  const { source, label, key, ttlMs, limit, gaps, fn, staleMs = DEFAULT_STALE_MS } = opts;

  const fresh = getCached<T>(key);
  if (fresh !== undefined) return { value: fresh, stale: false, ageMs: 0 };

  const serveStale = (why: string): FreeFetchResult<T> | null => {
    const stale = getStale<T>(key);
    if (!stale) return null;
    gaps.push(`${label} ${why}，改用 ${minutes(stale.ageMs)} 前的快取結果（stale，非即時）`);
    return { value: stale.value, stale: true, ageMs: stale.ageMs };
  };

  const decision = tryConsume(source, limit);
  if (!decision.ok) {
    const stale = serveStale(decision.reason);
    if (stale) return stale;
    gaps.push(`${label} ${decision.reason}，且無可用快取`);
    return null;
  }

  const value = await fn();
  if (value === null) {
    recordFailure(source);
    const stale = serveStale("本次取得失敗");
    if (stale) return stale;
    // Nothing fresh, nothing cached — the caller gets null, so the reason has
    // to be recorded here or it is lost entirely.
    gaps.push(`${label} 取得失敗，且無可用快取`);
    return null;
  }

  recordSuccess(source);
  setCached(key, value, ttlMs, staleMs);
  return { value, stale: false, ageMs: 0 };
}

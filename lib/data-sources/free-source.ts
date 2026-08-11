import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_STALE_MS, getCached, getStale, setCached } from "./cache";
import { recordFailure, recordSuccess, tryConsume, type QuotaLimit } from "./quota";
import { getSignalStore } from "@/lib/db";

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
  /**
   * Called only after `fn` returned null, to name the cause in the gap message.
   * "取得失敗" alone can't be acted on — a 429 and a timeout need opposite
   * fixes. Returning null keeps the generic wording.
   */
  diagnose?: () => string | null;
  /**
   * Called after a null result: was that a *transport* failure?
   *
   * Returning false means the request worked and the answer was simply empty —
   * a wrong contract code, a query that matched nothing. Those must not record
   * a failure, because the backoff is per-source and shared: one symbol's bad
   * config would otherwise suppress the same source for every other symbol in
   * the sweep, and retrying could never have helped anyway.
   */
  wasTransportFailure?: () => boolean;
  staleMs?: number;
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} 分鐘`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} 小時` : `${Math.round(h / 24)} 天`;
}


/**
 * The cross-invocation half of the cache.
 *
 * Lives here rather than in cache.ts because it is the only async layer: every
 * other caller of getCached is synchronous, and fetchFree is the one place all
 * free sources already funnel through and already await.
 *
 * Failures are swallowed on purpose. A cache is an optimisation; a deployment
 * with no database, or one whose `source_cache` table hasn't been created yet,
 * must behave exactly as it did before this existed.
 */
async function readPersisted<T>(
  key: string,
  ttlMs: number,
  staleMs: number,
): Promise<{ value: T; ageMs: number; fresh: boolean } | null> {
  const store = getSignalStore();
  if (!store) return null;
  try {
    const row = await store.readCache(key);
    if (!row) return null;
    const ageMs = Date.now() - new Date(row.fetchedAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs < 0) return null;
    if (ageMs > staleMs) return null;
    return { value: row.payload as T, ageMs, fresh: ageMs <= ttlMs };
  } catch {
    return null;
  }
}

async function writePersisted(key: string, value: unknown): Promise<void> {
  const store = getSignalStore();
  if (!store) return;
  try {
    await store.writeCache(key, value);
  } catch {
    // See above: never let a cache write cost the caller its result.
  }
}

/**
 * Request-scoped "skip the fresh cache" flag.
 *
 * Same mechanism as the per-request API keys: a flag threaded through twenty
 * fetchers as an argument is a flag that gets forgotten in one of them, and the
 * one that forgets is the one that keeps serving yesterday's price.
 */
const forceStore = new AsyncLocalStorage<boolean>();

/** Runs `fn` with every free source going to the network for fresh data. */
export function withFreshData<T>(fn: () => Promise<T>): Promise<T> {
  return forceStore.run(true, fn);
}

function isForced(): boolean {
  return forceStore.getStore() === true;
}

export async function fetchFree<T>(opts: FreeFetchOptions<T>): Promise<FreeFetchResult<T> | null> {
  const {
    source,
    label,
    key,
    ttlMs,
    limit,
    gaps,
    fn,
    diagnose,
    wasTransportFailure,
    staleMs = DEFAULT_STALE_MS,
  } = opts;

  // "重新分析" has to mean it. When the caller asked for fresh data, the two
  // *fresh* cache tiers are skipped and the source is actually called — a
  // refresh button that returns the cached answer is not a refresh button, and
  // that is precisely what made pressing it change nothing.
  //
  // The stale tier below is deliberately still reachable: forcing a fetch is a
  // request to try, not permission to invent. If the live call fails, an old
  // answer clearly labelled as old is still better than none.
  const forced = isForced();

  // Forcing means "no stale junk", not "refetch what was fetched twenty
  // seconds ago". A full-board 重整 is nine forced scans sharing the same
  // macro series — DXY, CPI, payrolls, the news queries — and refetching
  // each of them nine times in one burst is how the sweep blew through its
  // own per-minute budgets and finished the last symbols on stale caches and
  // eighteen gap lines ("每分鐘額度已用盡…改用 0 分鐘 前的快取" — a
  // zero-minute-old cache IS the fresh answer). Anything younger than this
  // is treated as the fresh fetch it just was, force or no force.
  const FORCE_ACCEPT_MS = 2 * 60 * 1000;

  const fresh = forced ? undefined : getCached<T>(key);
  if (fresh !== undefined) return { value: fresh, stale: false, ageMs: 0 };
  if (forced) {
    const recent = getStale<T>(key);
    if (recent && recent.ageMs <= FORCE_ACCEPT_MS) {
      return { value: recent.value, stale: false, ageMs: recent.ageMs };
    }
  }

  // Second look, in the database. On a serverless platform the in-memory cache
  // above is almost always empty — the process that filled it served one
  // request and was gone — so without this the whole caching layer was
  // decorative and every source hiccup became "無資料".
  const persisted = await readPersisted<T>(key, ttlMs, staleMs);
  if (persisted?.fresh && (!forced || persisted.ageMs <= FORCE_ACCEPT_MS)) {
    setCached(key, persisted.value, ttlMs - persisted.ageMs, staleMs - persisted.ageMs);
    return { value: persisted.value, stale: false, ageMs: persisted.ageMs };
  }

  const serveStale = (why: string): FreeFetchResult<T> | null => {
    const memory = getStale<T>(key);
    const best = memory ?? persisted;
    if (!best) return null;
    gaps.push(`${label} ${why}，改用 ${minutes(best.ageMs)} 前的快取結果（stale，非即時）`);
    return { value: best.value, stale: true, ageMs: best.ageMs };
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
    if (wasTransportFailure?.() !== false) recordFailure(source);
    const why = diagnose?.() ?? null;
    const stale = serveStale(why ? `本次取得失敗：${why}` : "本次取得失敗");
    if (stale) return stale;
    // Nothing fresh, nothing cached — the caller gets null, so the reason has
    // to be recorded here or it is lost entirely.
    gaps.push(`${label} 取得失敗${why ? `：${why}` : ""}，且無可用快取`);
    return null;
  }

  recordSuccess(source);
  setCached(key, value, ttlMs, staleMs);
  // Not awaited on the happy path's critical section, but awaited before
  // returning so a serverless function isn't frozen mid-write.
  await writePersisted(key, value);
  return { value, stale: false, ageMs: 0 };
}

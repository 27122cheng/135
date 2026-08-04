import type { RateSpreadConfig } from "@/config/rate-spreads";
import type { BiasItem } from "@/types/signal";
import { fetchYieldSeries, type YieldSeries } from "../data-sources/yields";

/**
 * 兩國利差 → 基本面 BiasItem.
 *
 * The signal is the **20-day change** in the differential, not its level. A
 * wide spread that has been wide for a year is already in the price; a spread
 * that moved 30bp in a month is the thing that repriced the currency.
 *
 * Two rules from the spec drive the awkward parts of this file:
 *  - 嚴禁用內插或前值填補. The two legs publish on different calendars, so the
 *    spread is only computed on dates where **both** legs actually have a
 *    printed value. Taking each leg's latest independently would silently pair
 *    a Friday German yield with a Thursday US one and call it today's spread.
 *  - EOD data can legitimately lag 1-2 trading days; beyond 3 it goes into
 *    data_gaps rather than being presented as current.
 */

/** Lookback for the change that carries the signal. */
const LOOKBACK_SESSIONS = 20;
/** Beyond this many business days behind, the spread is reported as stale. */
const MAX_STALE_SESSIONS = 3;

export interface AlignedSpread {
  /** Date both legs printed a value — the spread's true as-of. */
  as_of: string;
  /** minuend − subtrahend, in percent. */
  spread: number;
  minuend: number;
  subtrahend: number;
}

/**
 * Pairs the two series on dates present in both, oldest first. This is the
 * whole no-interpolation guarantee: a date missing from either leg simply
 * doesn't produce a spread.
 */
export function alignSeries(a: YieldSeries, b: YieldSeries): AlignedSpread[] {
  const byDate = new Map(b.points.map((p) => [p.date, p.value]));
  const out: AlignedSpread[] = [];
  for (const point of a.points) {
    const other = byDate.get(point.date);
    if (other === undefined) continue;
    out.push({
      as_of: point.date,
      spread: point.value - other,
      minuend: point.value,
      subtrahend: other,
    });
  }
  return out.sort((x, y) => x.as_of.localeCompare(y.as_of));
}

/**
 * Weekdays strictly after `from`, up to and including `to`'s date. Ignores
 * holidays, so it can only ever over-report staleness — the safe direction.
 *
 * `to` is truncated to its UTC date first: comparing a midnight cursor against
 * a mid-afternoon timestamp counts the current day as already elapsed, which
 * made every reading look a day staler than it was.
 */
export function businessDaysBetween(from: string, to: Date): number {
  const start = new Date(`${from}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return Number.POSITIVE_INFINITY;
  const end = new Date(
    Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()),
  );

  let count = 0;
  const cursor = new Date(start);
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

/** Spec's table: >25bp → 2, 10-25bp → 1, <10bp → 0. */
export function weightForChange(changeBp: number): 0 | 1 | 2 {
  const magnitude = Math.abs(changeBp);
  if (magnitude > 25) return 2;
  if (magnitude >= 10) return 1;
  return 0;
}

export interface RateSpreadResult {
  item: BiasItem | null;
  as_of: string | null;
  spread: number | null;
  changeBp: number | null;
}

/**
 * Builds the bias item from two already-fetched series. Split out from the
 * fetching so the arithmetic, the staleness rule and the weight table can be
 * tested without touching the network.
 */
export function computeRateSpread(
  config: RateSpreadConfig,
  minuendSeries: YieldSeries,
  subtrahendSeries: YieldSeries,
  gaps: string[],
  now: Date = new Date(),
): RateSpreadResult {
  const aligned = alignSeries(minuendSeries, subtrahendSeries);
  if (aligned.length === 0) {
    gaps.push(
      `${config.label}：${minuendSeries.label} 與 ${subtrahendSeries.label} 沒有共同的交易日，無法計算利差（不以前值填補）`,
    );
    return { item: null, as_of: null, spread: null, changeBp: null };
  }

  const latest = aligned[aligned.length - 1];

  const staleSessions = businessDaysBetween(latest.as_of, now);
  if (staleSessions > MAX_STALE_SESSIONS) {
    gaps.push(
      `${config.label} 最新資料為 ${latest.as_of}，已落後約 ${staleSessions} 個交易日（超過 ${MAX_STALE_SESSIONS} 日門檻），本次不計入計分`,
    );
    return { item: null, as_of: latest.as_of, spread: latest.spread, changeBp: null };
  }

  if (aligned.length <= LOOKBACK_SESSIONS) {
    gaps.push(
      `${config.label} 共同交易日僅 ${aligned.length} 天，不足 ${LOOKBACK_SESSIONS} 天，無法計算 20 日變化`,
    );
    return { item: null, as_of: latest.as_of, spread: latest.spread, changeBp: null };
  }

  const past = aligned[aligned.length - 1 - LOOKBACK_SESSIONS];
  // Percentage points → basis points.
  const changeBp = Math.round((latest.spread - past.spread) * 100);
  const weight = weightForChange(changeBp);

  // A rising spread always favours a long position — the config orders the two
  // legs so that this holds for every symbol (see config/rate-spreads.ts).
  const direction = weight === 0 ? "neutral" : changeBp > 0 ? "long" : "short";
  const movement = changeBp > 0 ? "擴大" : changeBp < 0 ? "收斂" : "持平";

  const item: BiasItem = {
    dimension: "基本面",
    factor: config.label,
    direction,
    weight,
    evidence:
      `${latest.spread.toFixed(2)}%（${minuendSeries.label} ${latest.minuend.toFixed(2)}% − ` +
      `${subtrahendSeries.label} ${latest.subtrahend.toFixed(2)}%），` +
      `${LOOKBACK_SESSIONS}日${movement} ${Math.abs(changeBp)}bp，as_of ${latest.as_of}`,
    source: `${minuendSeries.source} + ${subtrahendSeries.source}（EOD 殖利率，${config.rationale}）`,
  };

  return { item, as_of: latest.as_of, spread: latest.spread, changeBp };
}

/** Fetches both legs and computes the factor. Returns [] when unavailable. */
export async function analyzeRateSpread(
  config: RateSpreadConfig,
  gaps: string[],
): Promise<BiasItem[]> {
  const [minuend, subtrahend] = await Promise.all([
    fetchYieldSeries(config.minuend, gaps),
    fetchYieldSeries(config.subtrahend, gaps),
  ]);
  if (!minuend || !subtrahend) return [];

  const result = computeRateSpread(config, minuend, subtrahend, gaps);
  return result.item ? [result.item] : [];
}

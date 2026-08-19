import type { Candle } from "../data-sources/ohlcv";

/**
 * 相關性檢查 — which of these nine instruments are actually the same trade.
 *
 * ## Why the ranking page needs this
 *
 * The nav has promised 「附相關性檢查」 since the six-page architecture landed,
 * and the migration spec lists a 相關性熱力圖 — this is that, finally. The
 * ranking orders instruments by trend quality, which quietly invites taking
 * the top three at once. But EURUSD, GBPUSD and gold longs are, most weeks,
 * one short-dollar position wearing three names: three "independent" trades at
 * 1% risk each can be 3% on a single macro view. The USD-side table on the
 * board catches the FX/gold cluster by construction; this measures the whole
 * matrix from returns, so it also catches the pairs nobody hardcoded —
 * NAS100/SPX500 routinely above 0.9, WTI drifting in and out of the risk
 * complex.
 *
 * ## Method, and its honest limits
 *
 * Pearson correlation of daily log returns over the last 60 aligned sessions.
 * Alignment is by calendar date, because the series come from different
 * sources with different holiday calendars — correlating misaligned rows
 * produces confident nonsense, so dates that are not present in both series
 * are dropped and the *overlap* count is reported alongside every figure.
 * Fewer than 30 shared sessions returns null rather than a number: a
 * correlation on three weeks of data is a coin flip with decimals.
 *
 * 60 sessions is a compromise stated openly: short enough to track the
 * current regime (correlations move — gold/equities flips sign across
 * regimes), long enough that ±0.25 of sampling noise does not dominate. This
 * is a risk-clustering tool, not an estimate of the "true" correlation.
 */

/** Sessions of shared history used for each pairwise figure. */
export const CORRELATION_WINDOW = 60;
/** Below this many shared sessions a pair reports null, not a guess. */
export const MIN_OVERLAP = 30;
/** |r| at or above this flags a pair as "effectively one trade". */
export const CLUSTER_THRESHOLD = 0.7;

/** Closing prices keyed by the session's calendar date. */
function closesByDate(candles: Candle[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of candles) {
    if (c.close > 0) out.set(c.time.slice(0, 10), c.close);
  }
  return out;
}

function pearson(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 2) return null;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[i];
    sumB += b[i];
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return null;
  return cov / Math.sqrt(varA * varB);
}

export interface CorrelationPair {
  a: string;
  b: string;
  /** Pearson r over the shared sessions; null when overlap < MIN_OVERLAP. */
  r: number | null;
  /** How many aligned sessions the figure rests on. */
  overlap: number;
}

export interface CorrelationReport {
  symbols: string[];
  /** matrix[i][j] = r between symbols[i] and symbols[j]; 1 on the diagonal. */
  matrix: (number | null)[][];
  /** Every off-diagonal pair, strongest |r| first. */
  pairs: CorrelationPair[];
  /** Pairs at or beyond CLUSTER_THRESHOLD — the ones to size as one position. */
  clusters: CorrelationPair[];
  window: number;
  note: string;
}

export function correlationReport(
  seriesBySymbol: Record<string, Candle[] | undefined>,
): CorrelationReport {
  const symbols = Object.keys(seriesBySymbol).filter(
    (s) => (seriesBySymbol[s]?.length ?? 0) > MIN_OVERLAP,
  );
  const closes = new Map(symbols.map((s) => [s, closesByDate(seriesBySymbol[s]!)]));

  const matrix: (number | null)[][] = symbols.map(() => symbols.map(() => null));
  const pairs: CorrelationPair[] = [];

  for (let i = 0; i < symbols.length; i++) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < symbols.length; j++) {
      const ca = closes.get(symbols[i])!;
      const cb = closes.get(symbols[j])!;
      // Intersect the calendars FIRST, then compute both return streams over
      // the same shared grid. The order matters: computing each series' returns
      // on its own calendar and intersecting afterwards leaves the returns
      // around every holiday spanning different horizons — one side's "daily"
      // move covers two days, the other's covers one — which measurably drags
      // a genuinely perfect correlation down to ~0.92. Different providers
      // have different holiday calendars, so this is the common case, not an
      // edge case.
      const shared = [...ca.keys()].filter((d) => cb.has(d)).sort().slice(-(CORRELATION_WINDOW + 1));
      let r: number | null = null;
      if (shared.length >= MIN_OVERLAP + 1) {
        const retA: number[] = [];
        const retB: number[] = [];
        for (let k = 1; k < shared.length; k++) {
          retA.push(Math.log(ca.get(shared[k])! / ca.get(shared[k - 1])!));
          retB.push(Math.log(cb.get(shared[k])! / cb.get(shared[k - 1])!));
        }
        r = pearson(retA, retB);
        if (r !== null) r = Math.round(r * 100) / 100;
      }
      matrix[i][j] = r;
      matrix[j][i] = r;
      pairs.push({ a: symbols[i], b: symbols[j], r, overlap: Math.max(0, shared.length - 1) });
    }
  }

  pairs.sort((x, y) => Math.abs(y.r ?? 0) - Math.abs(x.r ?? 0));
  return {
    symbols,
    matrix,
    pairs,
    clusters: pairs.filter((p) => p.r !== null && Math.abs(p.r) >= CLUSTER_THRESHOLD),
    window: CORRELATION_WINDOW,
    note:
      `以最近 ${CORRELATION_WINDOW} 個共同交易日的日報酬計算 Pearson 相關係數，` +
      `依日期對齊（不同來源的休市日不同，逐列對齊會製造假象）。` +
      `|r| ≥ ${CLUSTER_THRESHOLD} 的兩個商品實質上是同一筆交易 —— 同時各下 1% 風險，等於對同一個觀點下 2%。` +
      `相關性會隨市場情勢改變，這是風險集中檢查，不是恆定關係。`,
  };
}

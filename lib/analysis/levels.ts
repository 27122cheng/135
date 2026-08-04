import type { Timeframe } from "@/types/signal";
import type { Candle } from "../data-sources/ohlcv";
import { findSwingPoints } from "./indicators";

/**
 * Turns raw swing points into consolidated price levels.
 *
 * Three precision problems this solves over using swings directly:
 *
 * 1. **Clustering.** Swings at 4100, 4102 and 4105 are one zone the market
 *    defended three times, not three separate weak levels. Merging them makes
 *    the touch count — and therefore the strength — reflect reality.
 * 2. **Volatility-relative tolerance.** A fixed 0.2% band is ~8 points on gold
 *    but ~20 pips on EUR/USD, which is far too wide for FX. Tolerance is a
 *    fraction of ATR instead, so it adapts per instrument automatically.
 * 3. **Cross-timeframe confluence.** A level that shows up on both D1 and W1
 *    is materially stronger than one that only appears on H4.
 */

export interface TaggedSwing {
  price: number;
  type: "high" | "low";
  index: number;
  timeframe: Timeframe;
}

export interface PriceLevel {
  /** Touch-weighted centre of the cluster. */
  price: number;
  /** How many swing points formed this level. */
  touches: number;
  /** Distinct timeframes that contributed — confluence. */
  timeframes: Timeframe[];
  /** Whether the level was formed by highs, lows, or both (both = flipped level). */
  kind: "high" | "low" | "mixed";
  /** 1-3, from touches plus confluence. */
  strength: 1 | 2 | 3;
}

/** Higher timeframes get a larger share of the strength budget. */
const TIMEFRAME_RANK: Record<Timeframe, number> = { M15: 0, H1: 1, H4: 2, D1: 3, W1: 4 };

export function collectSwings(
  candlesByTf: Partial<Record<Timeframe, Candle[]>>,
  lookback = 3,
): TaggedSwing[] {
  const out: TaggedSwing[] = [];
  for (const [tf, candles] of Object.entries(candlesByTf)) {
    if (!candles || candles.length < lookback * 2 + 1) continue;
    for (const s of findSwingPoints(candles, lookback)) {
      out.push({ price: s.price, type: s.type, index: s.index, timeframe: tf as Timeframe });
    }
  }
  return out;
}

function strengthOf(touches: number, timeframes: Timeframe[]): 1 | 2 | 3 {
  const topTf = Math.max(0, ...timeframes.map((t) => TIMEFRAME_RANK[t]));
  const confluent = timeframes.length >= 2;
  // A level defended 3+ times, or 2+ times with cross-timeframe agreement, or
  // sitting on the weekly chart, is the strongest tier.
  if (touches >= 3 || (touches >= 2 && confluent) || topTf >= TIMEFRAME_RANK.W1) return 3;
  if (touches >= 2 || topTf >= TIMEFRAME_RANK.D1) return 2;
  return 1;
}

/**
 * Greedy single-pass clustering over price-sorted swings. `tolerance` is an
 * absolute price distance — callers should derive it from ATR so it scales
 * with the instrument.
 */
export function clusterSwings(swings: TaggedSwing[], tolerance: number): PriceLevel[] {
  if (swings.length === 0 || !(tolerance > 0)) return [];

  const sorted = [...swings].sort((a, b) => a.price - b.price);
  const clusters: TaggedSwing[][] = [];
  let current: TaggedSwing[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const mean = current.reduce((sum, s) => sum + s.price, 0) / current.length;
    if (Math.abs(sorted[i].price - mean) <= tolerance) {
      current.push(sorted[i]);
    } else {
      clusters.push(current);
      current = [sorted[i]];
    }
  }
  clusters.push(current);

  return clusters.map((group) => {
    const price = group.reduce((sum, s) => sum + s.price, 0) / group.length;
    const timeframes = [...new Set(group.map((s) => s.timeframe))];
    const hasHigh = group.some((s) => s.type === "high");
    const hasLow = group.some((s) => s.type === "low");
    return {
      price: Math.round(price * 100000) / 100000,
      touches: group.length,
      timeframes,
      kind: hasHigh && hasLow ? "mixed" : hasHigh ? "high" : "low",
      strength: strengthOf(group.length, timeframes),
    } satisfies PriceLevel;
  });
}

/**
 * Tolerance for treating two prices as the same level. ATR-based when
 * available (adapts to the instrument), otherwise a small fraction of price.
 */
export function levelTolerance(price: number, atr: number | null): number {
  if (atr && atr > 0) return atr * 0.3;
  return price * 0.002;
}

/** Human-readable description of why a level is considered strong. */
export function describeLevel(level: PriceLevel): string {
  const tfs = level.timeframes
    .slice()
    .sort((a, b) => TIMEFRAME_RANK[b] - TIMEFRAME_RANK[a])
    .join("+");
  const kindLabel = level.kind === "mixed" ? "多空翻轉區" : level.kind === "high" ? "高點區" : "低點區";
  return `${tfs} ${kindLabel}，${level.touches} 次觸及${level.timeframes.length >= 2 ? "、跨時框共振" : ""}`;
}

import type { BiasItem, EntryStructure, PathObstacle, Timeframe } from "@/types/signal";
import type { Candle } from "../data-sources/ohlcv";
import { ema, findSwingPoints, macd, rsi, strengthFromTouches, countTouches } from "./indicators";
import { clusterSwings, collectSwings, describeLevel, levelTolerance, type PriceLevel } from "./levels";

export interface TechnicalResult {
  biasItems: BiasItem[];
  entryStructures: EntryStructure[];
  pathObstacles: PathObstacle[];
  atrD1: number | null;
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function alignToCandles<T>(candleLen: number, series: T[], offset: number): (T | null)[] {
  const out: (T | null)[] = new Array(candleLen).fill(null);
  for (let i = 0; i < series.length; i++) out[offset + i] = series[i];
  return out;
}

/** Nearest round-number level for the instrument, based on price magnitude. */
function roundLevelStep(price: number): number {
  if (price >= 1000) return 50; // indices, gold
  if (price >= 10) return 1; // WTI, JPY-quoted pairs (e.g. USD/JPY ~150)
  if (price >= 1) return 0.01; // most FX majors (e.g. EUR/USD ~1.08)
  return 0.0001;
}

export function analyzeTechnical(
  candlesByTf: Partial<Record<Timeframe, Candle[]>>,
  currentPrice: number,
  /** D1 ATR — sets how far apart two swings can be and still be one level. */
  atrForLevels: number | null,
  gaps: string[],
): TechnicalResult {
  const biasItems: BiasItem[] = [];
  const entryStructures: EntryStructure[] = [];
  const pathObstacles: PathObstacle[] = [];

  const d1 = candlesByTf.D1;

  let atrD1: number | null = null;

  if (d1 && d1.length >= 30) {
    const closes = d1.map((c) => c.close);

    // 1) Multi-period structure: HH/HL vs LH/LL from the last two swing highs/lows.
    const swings = findSwingPoints(d1, 2);
    const highs = swings.filter((s) => s.type === "high");
    const lows = swings.filter((s) => s.type === "low");
    if (highs.length >= 2 && lows.length >= 2) {
      const [h1, h2] = highs.slice(-2);
      const [l1, l2] = lows.slice(-2);
      const higherHigh = h2.price > h1.price;
      const higherLow = l2.price > l1.price;
      const lowerHigh = h2.price < h1.price;
      const lowerLow = l2.price < l1.price;
      if (higherHigh && higherLow) {
        biasItems.push({
          dimension: "技術面",
          factor: `D1 結構 HH/HL：高點 ${round(h1.price)}→${round(h2.price)}，低點 ${round(l1.price)}→${round(l2.price)}`,
          direction: "long",
          weight: 2,
          evidence: `swing high ${round(h1.price)}→${round(h2.price)}, swing low ${round(l1.price)}→${round(l2.price)}`,
          source: `Twelve Data/yfinance D1 K棒 ${h2.time}`,
        });
      } else if (lowerHigh && lowerLow) {
        biasItems.push({
          dimension: "技術面",
          factor: `D1 結構 LH/LL：高點 ${round(h1.price)}→${round(h2.price)}，低點 ${round(l1.price)}→${round(l2.price)}`,
          direction: "short",
          weight: 2,
          evidence: `swing high ${round(h1.price)}→${round(h2.price)}, swing low ${round(l1.price)}→${round(l2.price)}`,
          source: `Twelve Data/yfinance D1 K棒 ${h2.time}`,
        });
      } else {
        biasItems.push({
          dimension: "技術面",
          factor: "D1 結構混合，未形成明確 HH/HL 或 LH/LL",
          direction: "neutral",
          weight: 0,
          evidence: `swing high ${round(h1.price)}→${round(h2.price)}, swing low ${round(l1.price)}→${round(l2.price)}`,
          source: `Twelve Data/yfinance D1 K棒 ${h2.time}`,
        });
      }
    } else {
      gaps.push("D1 K棒不足以判斷 HH/HL 結構（需要至少兩組擺盪高低點）");
    }

    // 2) EMA20/50/200 alignment.
    if (closes.length >= 200) {
      const ema20 = ema(closes, 20).at(-1)!;
      const ema50 = ema(closes, 50).at(-1)!;
      const ema200 = ema(closes, 200).at(-1)!;
      const price = closes.at(-1)!;
      if (price > ema20 && ema20 > ema50 && ema50 > ema200) {
        biasItems.push({
          dimension: "技術面",
          factor: `D1 EMA 多頭排列：價格${round(price)} > EMA20(${round(ema20)}) > EMA50(${round(ema50)}) > EMA200(${round(ema200)})`,
          direction: "long",
          weight: 2,
          evidence: `EMA20=${round(ema20)}, EMA50=${round(ema50)}, EMA200=${round(ema200)}`,
          source: "Twelve Data/yfinance D1 收盤價",
        });
      } else if (price < ema20 && ema20 < ema50 && ema50 < ema200) {
        biasItems.push({
          dimension: "技術面",
          factor: `D1 EMA 空頭排列：價格${round(price)} < EMA20(${round(ema20)}) < EMA50(${round(ema50)}) < EMA200(${round(ema200)})`,
          direction: "short",
          weight: 2,
          evidence: `EMA20=${round(ema20)}, EMA50=${round(ema50)}, EMA200=${round(ema200)}`,
          source: "Twelve Data/yfinance D1 收盤價",
        });
      } else {
        biasItems.push({
          dimension: "技術面",
          factor: "D1 EMA20/50/200 未形成單向排列",
          direction: "neutral",
          weight: 0,
          evidence: `EMA20=${round(ema20)}, EMA50=${round(ema50)}, EMA200=${round(ema200)}`,
          source: "Twelve Data/yfinance D1 收盤價",
        });
      }
    } else {
      gaps.push("D1 K棒不足 200 根，無法計算 EMA200 排列");
    }

    // 3) RSI(14) divergence vs. the last two swing highs/lows.
    const rsiSeries = rsi(closes, 14);
    const rsiAligned = alignToCandles(d1.length, rsiSeries, closes.length - rsiSeries.length);
    if (highs.length >= 2) {
      const [h1, h2] = highs.slice(-2);
      const r1 = rsiAligned[h1.index];
      const r2 = rsiAligned[h2.index];
      if (r1 != null && r2 != null && h2.price > h1.price && r2 < r1) {
        biasItems.push({
          dimension: "技術面",
          factor: `D1 RSI 頂背離：價格創新高 (${round(h1.price)}→${round(h2.price)}) 但 RSI 走低 (${round(r1)}→${round(r2)})`,
          direction: "short",
          weight: 1,
          evidence: `RSI ${round(r1)}→${round(r2)}`,
          source: `Twelve Data/yfinance D1 K棒 ${h2.time}`,
        });
      }
    }
    if (lows.length >= 2) {
      const [l1, l2] = lows.slice(-2);
      const r1 = rsiAligned[l1.index];
      const r2 = rsiAligned[l2.index];
      if (r1 != null && r2 != null && l2.price < l1.price && r2 > r1) {
        biasItems.push({
          dimension: "技術面",
          factor: `D1 RSI 底背離：價格創新低 (${round(l1.price)}→${round(l2.price)}) 但 RSI 走高 (${round(r1)}→${round(r2)})`,
          direction: "long",
          weight: 1,
          evidence: `RSI ${round(r1)}→${round(r2)}`,
          source: `Twelve Data/yfinance D1 K棒 ${l2.time}`,
        });
      }
    }

    // 4) MACD histogram as momentum confirmation.
    const macdResult = macd(closes);
    const lastHist = macdResult.histogram.at(-1);
    if (lastHist != null) {
      biasItems.push({
        dimension: "技術面",
        factor: `D1 MACD 柱狀圖 ${lastHist > 0 ? "翻正" : "翻負"} (${round(lastHist)})`,
        direction: lastHist > 0 ? "long" : lastHist < 0 ? "short" : "neutral",
        weight: 1,
        evidence: `MACD histogram=${round(lastHist)}`,
        source: "Twelve Data/yfinance D1 收盤價",
      });
    }

    atrD1 = null; // computed by caller via indicators.atr on raw D1 candles (kept out of this module for cache reuse)
  } else {
    gaps.push("D1 K棒不足（需 ≥30 根）以進行技術面分析");
  }

  // Structures come from *clustered* levels rather than raw swings: swings a
  // few ticks apart are one zone the market defended repeatedly, and merging
  // them makes both the price and the strength reflect that. Tolerance scales
  // with ATR so it fits the instrument instead of a fixed percentage.
  const tolerance = levelTolerance(currentPrice, atrForLevels);
  const levels = clusterSwings(collectSwings(candlesByTf, 3), tolerance);
  if (levels.length === 0) {
    gaps.push("K棒不足以聚合出有效的價格結構區");
  }

  const dominantTf = (level: PriceLevel): Timeframe =>
    level.timeframes.includes("W1") ? "W1" : level.timeframes.includes("D1") ? "D1" : "H4";

  const supports = levels
    .filter((l) => l.price < currentPrice)
    .sort((a, b) => b.price - a.price);
  const resistances = levels
    .filter((l) => l.price > currentPrice)
    .sort((a, b) => a.price - b.price);

  // Entry structures: the nearest few levels on each side. Everything within
  // reach of the entry is offered; the scoring rules apply the 1.5% filter.
  for (const level of supports.slice(0, 3)) {
    entryStructures.push({
      price: round(level.price),
      type: level.timeframes.includes("W1") ? "週線S/R" : level.kind === "low" ? "前低" : "日線S/R",
      role: "support",
      timeframe: dominantTf(level),
      strength: level.strength,
      distance_pct: round(((currentPrice - level.price) / currentPrice) * 100),
    });
  }
  for (const level of resistances.slice(0, 3)) {
    entryStructures.push({
      price: round(level.price),
      type: level.timeframes.includes("W1") ? "週線S/R" : level.kind === "high" ? "前高" : "日線S/R",
      role: "resistance",
      timeframe: dominantTf(level),
      strength: level.strength,
      distance_pct: round(((currentPrice - level.price) / currentPrice) * 100),
    });
  }

  // Round-number level (整數關卡) closest above and below price.
  const step = roundLevelStep(currentPrice);
  const below = Math.floor(currentPrice / step) * step;
  const above = below + step;
  if (d1) {
    entryStructures.push(
      {
        price: round(below),
        type: "整數關卡",
        role: "support",
        timeframe: "D1",
        strength: strengthFromTouches(countTouches(d1, below, 0.15)),
        distance_pct: round(((currentPrice - below) / currentPrice) * 100),
      },
      {
        price: round(above),
        type: "整數關卡",
        role: "resistance",
        timeframe: "D1",
        strength: strengthFromTouches(countTouches(d1, above, 0.15)),
        distance_pct: round(((currentPrice - above) / currentPrice) * 100),
      },
    );
  }

  // Path obstacles: the same clustered levels, further out — these place the
  // take-profits, so their strength now carries real touch/confluence meaning.
  for (const level of [...resistances.slice(0, 4), ...supports.slice(0, 4)]) {
    pathObstacles.push({
      price: round(level.price),
      type: describeLevel(level),
      timeframe: dominantTf(level),
      strength: level.strength,
    });
  }

  return { biasItems, entryStructures, pathObstacles, atrD1 };
}

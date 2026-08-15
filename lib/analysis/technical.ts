import type { BiasItem, EntryStructure, PathObstacle, Timeframe } from "@/types/signal";
import type { Candle } from "../data-sources/ohlcv";
import { efficiencyRatio, ema, findSwingPoints, macd, rsi, strengthFromTouches, countTouches } from "./indicators";
import { candleSignals, falseBreakSignal, unfilledGapSignal } from "./candles";
import { clusterSwings, collectSwings, describeLevel, levelTolerance, type PriceLevel } from "./levels";
import {
  fibRetracementLevels,
  mergeDerived,
  priorPeriodLevels,
  roundNumberLevels,
} from "./derived-levels";

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

    // Trend *quality* first, because it conditions the two votes below. An
    // EMA stack and a HH/HL pair look identical in a grinding trend and in a
    // whipsaw that happens to end higher; Kaufman's efficiency ratio is the
    // denominator that knows the difference. In chop, a trend call is worth
    // one notch less — not silenced (the direction may still be right), just
    // no longer allowed to claim full conviction. Thresholds: ≥0.35 has been
    // going somewhere, <0.18 is a round trip in progress.
    const er = efficiencyRatio(closes, 20);
    const choppy = er !== null && er < 0.18;
    const trending = er !== null && er >= 0.35;
    const trendWeight = (w: 0 | 1 | 2): 0 | 1 | 2 =>
      choppy ? ((Math.max(0, w - 1) as 0 | 1 | 2)) : w;
    const chopNote = choppy ? `（盤整環境 ER=${round(er!)}，權重降一級）` : "";
    if (er !== null) {
      biasItems.push({
        dimension: "技術面",
        factor: `D1 趨勢效率比 ER(20)=${round(er)} —— ${trending ? "趨勢行進中" : choppy ? "盤整（趨勢票已降權）" : "過渡帶"}`,
        direction: "neutral",
        weight: 0,
        evidence: `淨位移 ÷ 路徑總長 = ${round(er)}；≥0.35 視為趨勢、<0.18 視為盤整`,
        source: "Twelve Data/yfinance D1 收盤價",
      });
    }

    // 1) Swing structure, Dow-style — over the last *three* highs and lows,
    // not two. A single noisy pivot used to flip the whole trend call; now
    // two consecutive agreeing pairs are a 成熟趨勢 (weight 2) and a single
    // agreeing pair is a 單段趨勢 (weight 1) — a trend that has only done it
    // once has only proven it once.
    const swings = findSwingPoints(d1, 2);
    const highs = swings.filter((s) => s.type === "high");
    const lows = swings.filter((s) => s.type === "low");
    if (highs.length >= 2 && lows.length >= 2) {
      const hs = highs.slice(-3);
      const ls = lows.slice(-3);
      const pair = (a: { price: number }, b: { price: number }) =>
        b.price > a.price ? 1 : b.price < a.price ? -1 : 0;
      const latestUp = pair(hs.at(-2)!, hs.at(-1)!) > 0 && pair(ls.at(-2)!, ls.at(-1)!) > 0;
      const latestDown = pair(hs.at(-2)!, hs.at(-1)!) < 0 && pair(ls.at(-2)!, ls.at(-1)!) < 0;
      const hasPrevPair = hs.length >= 3 && ls.length >= 3;
      const prevUp = hasPrevPair && pair(hs[0], hs[1]) > 0 && pair(ls[0], ls[1]) > 0;
      const prevDown = hasPrevPair && pair(hs[0], hs[1]) < 0 && pair(ls[0], ls[1]) < 0;

      const trail =
        `高點 ${hs.map((s) => round(s.price)).join("→")}，低點 ${ls.map((s) => round(s.price)).join("→")}`;
      if (latestUp || latestDown) {
        const matured = latestUp ? prevUp : prevDown;
        const baseWeight: 1 | 2 = matured ? 2 : 1;
        biasItems.push({
          dimension: "技術面",
          factor:
            `D1 結構 ${latestUp ? "HH/HL" : "LH/LL"}${matured ? "（連兩段同向，成熟趨勢）" : "（僅最近一段，單段趨勢）"}：${trail}` +
            chopNote,
          direction: latestUp ? "long" : "short",
          weight: trendWeight(baseWeight),
          evidence: trail + (hasPrevPair ? "" : "；僅有兩組擺盪點，無法確認前一段"),
          source: `Twelve Data/yfinance D1 K棒 ${hs.at(-1)!.time}`,
        });
      } else {
        biasItems.push({
          dimension: "技術面",
          factor: "D1 結構混合，未形成明確 HH/HL 或 LH/LL",
          direction: "neutral",
          weight: 0,
          evidence: trail,
          source: `Twelve Data/yfinance D1 K棒 ${hs.at(-1)!.time}`,
        });
      }
    } else {
      gaps.push("D1 K棒不足以判斷 HH/HL 結構（需要至少兩組擺盪高低點）");
    }

    // 2) EMA alignment, with partial credit and a slope check. The old rule
    // was all-or-nothing: a market where EMA20 briefly dipped under EMA50 in
    // an obvious uptrend got no vote at all, identical to genuine disorder.
    // Now the full stack keeps weight 2, and the coarser reading — price and
    // EMA50 on the same side of a *sloping* EMA50/EMA200 — still counts for
    // 1: the primary trend is a coarser fact than the 20-day wiggle.
    if (closes.length >= 200) {
      const ema20s = ema(closes, 20);
      const ema50s = ema(closes, 50);
      const ema20 = ema20s.at(-1)!;
      const ema50 = ema50s.at(-1)!;
      const ema200 = ema(closes, 200).at(-1)!;
      const price = closes.at(-1)!;
      // Slope over ~two trading weeks; flat EMAs claim no direction.
      const slope50 = ema50 - ema50s.at(-11)!;
      const emaEvidence = `EMA20=${round(ema20)}, EMA50=${round(ema50)}, EMA200=${round(ema200)}, EMA50十日斜率=${round(slope50)}`;
      if (price > ema20 && ema20 > ema50 && ema50 > ema200) {
        biasItems.push({
          dimension: "技術面",
          factor: `D1 EMA 多頭排列：價格${round(price)} > EMA20 > EMA50 > EMA200${chopNote}`,
          direction: "long",
          weight: trendWeight(2),
          evidence: emaEvidence,
          source: "Twelve Data/yfinance D1 收盤價",
        });
      } else if (price < ema20 && ema20 < ema50 && ema50 < ema200) {
        biasItems.push({
          dimension: "技術面",
          factor: `D1 EMA 空頭排列：價格${round(price)} < EMA20 < EMA50 < EMA200${chopNote}`,
          direction: "short",
          weight: trendWeight(2),
          evidence: emaEvidence,
          source: "Twelve Data/yfinance D1 收盤價",
        });
      } else if (price > ema50 && ema50 > ema200 && slope50 > 0) {
        biasItems.push({
          dimension: "技術面",
          factor: `D1 主趨勢偏多（排列未完整）：價格 > EMA50 > EMA200 且 EMA50 上斜，EMA20 糾結中${chopNote}`,
          direction: "long",
          weight: trendWeight(1),
          evidence: emaEvidence,
          source: "Twelve Data/yfinance D1 收盤價",
        });
      } else if (price < ema50 && ema50 < ema200 && slope50 < 0) {
        biasItems.push({
          dimension: "技術面",
          factor: `D1 主趨勢偏空（排列未完整）：價格 < EMA50 < EMA200 且 EMA50 下斜，EMA20 糾結中${chopNote}`,
          direction: "short",
          weight: trendWeight(1),
          evidence: emaEvidence,
          source: "Twelve Data/yfinance D1 收盤價",
        });
      } else {
        biasItems.push({
          dimension: "技術面",
          factor: "D1 EMA 未形成方向一致的排列（含粗粒度判讀）",
          direction: "neutral",
          weight: 0,
          evidence: emaEvidence,
          source: "Twelve Data/yfinance D1 收盤價",
        });
      }
    } else {
      gaps.push("D1 K棒不足 200 根，無法計算 EMA200 排列");
    }

    // 3) RSI(14): the current reading always, divergence when present.
    //
    // The reading itself is deliberately weight 0: RSI being at 62 is not a
    // trade thesis, and overbought-means-short is exactly the reflex that
    // fights every strong trend. But the number was being computed and then
    // shown to nobody unless a divergence happened to exist — the card said
    // "技術面" and could not answer "so what's the RSI?". Now it always
    // testifies; it just doesn't vote.
    const rsiSeries = rsi(closes, 14);
    const lastRsi = rsiSeries.at(-1);
    if (lastRsi != null) {
      const zone = lastRsi >= 70 ? "超買區（≥70）" : lastRsi <= 30 ? "超賣區（≤30）" : "中性區";
      biasItems.push({
        dimension: "技術面",
        factor: `D1 RSI(14) = ${round(lastRsi)}，位於${zone}`,
        direction: "neutral",
        weight: 0,
        evidence: `RSI(14)=${round(lastRsi)}`,
        source: "Twelve Data/yfinance D1 收盤價",
      });
    }
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

  // W1 anchor — the timeframe above must get a voice, or "higher timeframe
  // first" is a slogan the vote table doesn't implement. One coarse reading:
  // price vs W1 EMA20 AND the latest weekly swing pair agreeing = weight 1;
  // anything mixed stays a stated, non-voting fact.
  const w1 = candlesByTf.W1;
  if (w1 && w1.length >= 25) {
    const closesW = w1.map((c) => c.close);
    const emaW20 = ema(closesW, 20).at(-1)!;
    const priceW = closesW.at(-1)!;
    const swingsW = findSwingPoints(w1, 2);
    const highsW = swingsW.filter((s) => s.type === "high").slice(-2);
    const lowsW = swingsW.filter((s) => s.type === "low").slice(-2);
    if (highsW.length === 2 && lowsW.length === 2) {
      const upW = highsW[1].price > highsW[0].price && lowsW[1].price > lowsW[0].price;
      const downW = highsW[1].price < highsW[0].price && lowsW[1].price < lowsW[0].price;
      const evidenceW =
        `W1 收盤 ${round(priceW)} vs EMA20 ${round(emaW20)}；週線高點 ${round(highsW[0].price)}→${round(highsW[1].price)}、低點 ${round(lowsW[0].price)}→${round(lowsW[1].price)}`;
      if (upW && priceW > emaW20) {
        biasItems.push({
          dimension: "技術面",
          factor: "W1 週線偏多：價格在週線 EMA20 之上且週線結構 HH/HL",
          direction: "long",
          weight: 1,
          evidence: evidenceW,
          source: `Twelve Data/yfinance W1 K棒 ${highsW[1].time}`,
        });
      } else if (downW && priceW < emaW20) {
        biasItems.push({
          dimension: "技術面",
          factor: "W1 週線偏空：價格在週線 EMA20 之下且週線結構 LH/LL",
          direction: "short",
          weight: 1,
          evidence: evidenceW,
          source: `Twelve Data/yfinance W1 K棒 ${highsW[1].time}`,
        });
      } else {
        biasItems.push({
          dimension: "技術面",
          factor: "W1 週線方向不明（EMA 位置與週線結構未同向）",
          direction: "neutral",
          weight: 0,
          evidence: evidenceW,
          source: `Twelve Data/yfinance W1 K棒 ${highsW[1].time}`,
        });
      }
    }
  }

  // Structures come from *clustered* levels rather than raw swings: swings a
  // few ticks apart are one zone the market defended repeatedly, and merging
  // them makes both the price and the strength reflect that. Tolerance scales
  // with ATR so it fits the instrument instead of a fixed percentage.
  const tolerance = levelTolerance(currentPrice, atrForLevels);
  const clusters = clusterSwings(collectSwings(candlesByTf, 3), tolerance);

  // Swing clusters alone were the binding constraint on whether a signal could
  // trade at all: no cluster within 1.5% of price means no anchorable stop,
  // which force-grades the signal no-trade regardless of how well it scored.
  // These three fill the gaps between swings, cost nothing (pure functions over
  // candles already fetched), and carry strength 1 so they can anchor a stop
  // without ever outweighing a level price actually turned at.
  const levels = mergeDerived(
    clusters,
    [
      ...roundNumberLevels(currentPrice),
      ...priorPeriodLevels(candlesByTf),
      ...fibRetracementLevels(candlesByTf.D1),
    ],
    tolerance,
  );

  if (clusters.length === 0) {
    gaps.push("K棒不足以聚合出有效的價格結構區，僅以整數關卡／前期高低／斐波那契補位");
  }
  if (levels.length === 0) {
    gaps.push("完全找不到可用的價格結構");
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

  // 裸K反轉訊號 — after the structures, because a candle shape only votes
  // when its wick actually tested one of them. D1 for the primary trend
  // read, H4 for the day-trade trigger; each contributes at most one item.
  biasItems.push(
    ...candleSignals("D1", d1, atrForLevels, entryStructures),
    ...candleSignals("H4", candlesByTf.H4, atrForLevels, entryStructures),
  );

  // 假突破 carries weight 2 — heavier than a plain reversal candle — because
  // it is not a shape but the outcome of a fight over a level the analysis
  // already named. D1 first: a daily spring outranks an H4 one, and one
  // verdict per instrument is enough.
  const falseBreak =
    falseBreakSignal("D1", d1, atrForLevels, entryStructures) ??
    falseBreakSignal("H4", candlesByTf.H4, atrForLevels, entryStructures);
  if (falseBreak) biasItems.push(falseBreak);

  // Unfilled gaps are position information, not a vote — see the module note.
  const gapItem = unfilledGapSignal("D1", d1);
  if (gapItem) biasItems.push(gapItem);

  return { biasItems, entryStructures, pathObstacles, atrD1 };
}

import type { BiasItem } from "@/types/signal";
import type { Candle } from "../data-sources/ohlcv";
import { atr as computeAtr, ema } from "./indicators";

/**
 * 量化統計 — the numbers a quant desk puts beside a discretionary call.
 *
 * None of this picks a direction. It describes the instrument's current
 * behaviour in units the plan can be checked against:
 *
 *  - **波動率位階**: today's ATR against the last year of ATRs. A stop sized
 *    in a low-vol regime is wrong the week vol doubles.
 *  - **乖離**: close minus EMA20 in ATRs. Past ±2 the entry is chasing, and
 *    the mean-reversion risk is real enough to vote against the chase.
 *  - **自相關**: lag-1 autocorrelation of daily returns over 60 days. Positive
 *    means moves follow through (trend tactics pay); negative means they
 *    revert (fade tactics pay). Reported, never a vote — it is a regime hint.
 *  - **動能位階**: 20-day return and where it sits in the last year.
 *  - **預期波動**: ATR × √h for the plan's horizon, and the target and stop
 *    expressed in those units. A target four expected moves away is a wish.
 *  - **基準率**: over the history, how often price travelled the target's
 *    distance in the plan's direction before travelling the stop's distance
 *    against it, starting from *any* bar. This is the unconditional base
 *    rate the plan's conditioned backtest has to beat to claim an edge.
 */

export interface QuantStats {
  bars: number;
  atr14: number;
  atrPct: number;
  volPercentile: number | null;
  volLabel: "低波動" | "正常" | "高波動" | "無法判定";
  extensionAtr: number | null;
  autocorr1: number | null;
  autocorrLabel: "趨勢延續" | "均值回歸" | "接近隨機" | "樣本不足";
  momentum20Pct: number | null;
  momentumPercentile: number | null;
  /** ATR × √horizon, as a price distance and as a percent of price. */
  expectedMove: { bars: number; price: number; pct: number } | null;
  plan: {
    targetMoves: number;
    stopMoves: number;
    /** Share of historical starts that reached the target distance first, 0-1. */
    baseRate: number | null;
    samples: number;
  } | null;
  lines: string[];
}

export const EXTENSION_VOTE_ATR = 2;
export const AUTOCORR_BARS = 60;
export const VOL_LOOKBACK = 250;
export const BASE_RATE_HORIZON = 5;
const AUTOCORR_BAND = 0.1;

const r2 = (n: number) => Math.round(n * 100) / 100;

function percentileOf(value: number, sample: number[]): number | null {
  if (sample.length < 30) return null;
  const below = sample.filter((s) => s < value).length;
  return Math.round((below / sample.length) * 100);
}

function autocorr(returns: number[]): number | null {
  const n = returns.length;
  if (n < 20) return null;
  const m = returns.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    den += (returns[i] - m) ** 2;
    if (i > 0) num += (returns[i] - m) * (returns[i - 1] - m);
  }
  return den > 0 ? r2(num / den) : null;
}

/** ATR(14) series — one value per bar from the 15th on, for the vol percentile. */
function atrSeries(candles: Candle[], period = 14): number[] {
  const out: number[] = [];
  for (let i = period + 1; i <= candles.length; i++) {
    const a = computeAtr(candles.slice(Math.max(0, i - period * 3), i), period);
    if (a !== null) out.push(a);
  }
  return out;
}

export function quantStats(candles: Candle[] | undefined, price: number, horizonBars = BASE_RATE_HORIZON): QuantStats | null {
  if (!candles || candles.length < 30 || !(price > 0)) return null;
  const closes = candles.map((c) => c.close);
  const atr14 = computeAtr(candles, 14);
  if (atr14 === null || !(atr14 > 0)) return null;
  const atrPct = r2((atr14 / price) * 100);

  const series = atrSeries(candles.slice(-VOL_LOOKBACK));
  const volPercentile = percentileOf(atr14, series.slice(0, -1));
  const volLabel: QuantStats["volLabel"] =
    volPercentile === null ? "無法判定" : volPercentile >= 80 ? "高波動" : volPercentile <= 20 ? "低波動" : "正常";

  const e20 = ema(closes, 20);
  const last20 = e20[e20.length - 1];
  const extensionAtr = Number.isFinite(last20) ? r2((closes[closes.length - 1] - last20) / atr14) : null;

  const rets: number[] = [];
  for (let i = Math.max(1, closes.length - AUTOCORR_BARS); i < closes.length; i++) {
    if (closes[i - 1] > 0) rets.push(closes[i] / closes[i - 1] - 1);
  }
  const autocorr1 = autocorr(rets);
  const autocorrLabel: QuantStats["autocorrLabel"] =
    autocorr1 === null ? "樣本不足" : autocorr1 > AUTOCORR_BAND ? "趨勢延續" : autocorr1 < -AUTOCORR_BAND ? "均值回歸" : "接近隨機";

  const n = closes.length;
  const momentum20Pct = n > 20 && closes[n - 21] > 0 ? r2((closes[n - 1] / closes[n - 21] - 1) * 100) : null;
  const momHistory: number[] = [];
  for (let i = 20; i < n - 1; i++) if (closes[i - 20] > 0) momHistory.push((closes[i] / closes[i - 20] - 1) * 100);
  const momentumPercentile = momentum20Pct === null ? null : percentileOf(momentum20Pct, momHistory.slice(-VOL_LOOKBACK));

  const movePrice = atr14 * Math.sqrt(horizonBars);
  const expectedMove = { bars: horizonBars, price: r2(movePrice), pct: r2((movePrice / price) * 100) };

  const lines = [
    `波動率：ATR(14) ${r2(atr14)}（${atrPct}%），位階 ${volPercentile === null ? "—" : `${volPercentile}%`} → ${volLabel}`,
    `乖離：收盤距 EMA20 ${extensionAtr === null ? "—" : `${extensionAtr > 0 ? "+" : ""}${extensionAtr} ATR`}${extensionAtr !== null && Math.abs(extensionAtr) >= EXTENSION_VOTE_ATR ? "（過度延伸）" : ""}`,
    `自相關：lag-1 ${autocorr1 === null ? "—" : autocorr1} → ${autocorrLabel}（近 ${rets.length} 日）`,
    `動能：20 日 ${momentum20Pct === null ? "—" : `${momentum20Pct > 0 ? "+" : ""}${momentum20Pct}%`}，位階 ${momentumPercentile === null ? "—" : `${momentumPercentile}%`}`,
    `預期波動：${horizonBars} 日 ≈ ${expectedMove.price}（${expectedMove.pct}%）`,
  ];

  return {
    bars: n, atr14: r2(atr14), atrPct, volPercentile, volLabel, extensionAtr, autocorr1, autocorrLabel,
    momentum20Pct, momentumPercentile, expectedMove, plan: null, lines,
  };
}

/** Historical base rate: target distance reached before stop distance, from every start bar. */
export function baseRate(
  candles: Candle[],
  direction: "long" | "short",
  targetDist: number,
  stopDist: number,
  horizonBars: number,
): { rate: number | null; samples: number } {
  if (!(targetDist > 0) || !(stopDist > 0)) return { rate: null, samples: 0 };
  let wins = 0;
  let samples = 0;
  for (let i = 0; i + horizonBars < candles.length; i++) {
    const start = candles[i].close;
    let outcome: "win" | "loss" | null = null;
    for (let j = i + 1; j <= i + horizonBars && outcome === null; j++) {
      const c = candles[j];
      const up = c.high - start;
      const down = start - c.low;
      const toTarget = direction === "long" ? up : down;
      const toStop = direction === "long" ? down : up;
      const hitT = toTarget >= targetDist;
      const hitS = toStop >= stopDist;
      // Both inside one bar is ambiguous; count it against the plan.
      if (hitS) outcome = "loss";
      else if (hitT) outcome = "win";
    }
    if (outcome === null) continue;
    samples++;
    if (outcome === "win") wins++;
  }
  return { rate: samples > 0 ? r2(wins / samples) : null, samples };
}

export function withPlan(
  stats: QuantStats | null,
  candles: Candle[] | undefined,
  direction: "long" | "short",
  plan: { entry: number | null; stop_loss: number | null; take_profit: number | null },
): QuantStats | null {
  if (!stats || !candles || plan.entry === null || plan.stop_loss === null || plan.take_profit === null) return stats;
  const move = stats.expectedMove?.price ?? 0;
  if (!(move > 0)) return stats;
  const targetDist = Math.abs(plan.take_profit - plan.entry);
  const stopDist = Math.abs(plan.entry - plan.stop_loss);
  const br = baseRate(candles, direction, targetDist, stopDist, stats.expectedMove?.bars ?? BASE_RATE_HORIZON);
  const planStats = {
    targetMoves: r2(targetDist / move),
    stopMoves: r2(stopDist / move),
    baseRate: br.rate,
    samples: br.samples,
  };
  const lines = [
    ...stats.lines,
    `目標距離 = ${planStats.targetMoves} 個預期波動，停損 = ${planStats.stopMoves} 個` +
      (planStats.targetMoves > 2 ? "（目標偏遠）" : ""),
    br.rate === null
      ? "基準率：樣本不足"
      : `基準率：任意起點 ${stats.expectedMove?.bars} 日內先到目標的比例 ${Math.round(br.rate * 100)}%（${br.samples} 個起點）—— 回測勝率要高於這個數才算有優勢`,
  ];
  return { ...stats, plan: planStats, lines };
}

/** The one vote quant makes: an entry chasing more than EXTENSION_VOTE_ATR beyond EMA20. */
export function quantItems(stats: QuantStats | null): BiasItem[] {
  if (!stats || stats.extensionAtr === null) return [];
  const items: BiasItem[] = [];
  if (Math.abs(stats.extensionAtr) >= EXTENSION_VOTE_ATR) {
    items.push({
      dimension: "技術面",
      factor: `乖離過大：收盤距 EMA20 ${stats.extensionAtr > 0 ? "+" : ""}${stats.extensionAtr} ATR`,
      direction: stats.extensionAtr > 0 ? "short" : "long",
      weight: 1,
      evidence: `超過 ±${EXTENSION_VOTE_ATR} ATR 的延伸，均值回歸風險高於順勢追價的報酬`,
      source: "D1 量化統計",
      key: "quant-extension",
    });
  }
  items.push({
    dimension: "技術面",
    factor: `日報酬自相關 ${stats.autocorr1 ?? "—"}（${stats.autocorrLabel}）`,
    direction: "neutral",
    weight: 0,
    evidence: `波動率位階 ${stats.volPercentile ?? "—"}%（${stats.volLabel}），20 日動能位階 ${stats.momentumPercentile ?? "—"}%；只顯示不投票`,
    source: "D1 量化統計",
    key: "quant-regime",
  });
  return items;
}

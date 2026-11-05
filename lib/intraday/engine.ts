import type { Candle } from "../data-sources/ohlcv";
import { atr as computeAtr, ema, findSwingPoints } from "../analysis/indicators";
import { backtestPlanGeometry, type PlanBacktest } from "../analysis/backtest";
import { MAX_STOP_ATR, MIN_STOP_ATR, STOP_BUFFER_ATR } from "../analysis/lab-manage";
import { TRADE_VETO_EXPECTANCY_R, TRADE_VETO_HIT_RATE } from "../analysis/floors";

/**
 * 日內模式（加密貨幣）— H1 看背景、M15 找回踩，確認進場。
 *
 * Why crypto only: it is the one market with a free, keyless, real-time feed
 * that carries volume (Binance). An intraday engine on 15-minute-delayed FX
 * quotes would print entries the market had already left.
 *
 * The playbook is the same one the H4 engine runs, one level down:
 *  - H1 背景: close above EMA20 above EMA50 and the last swing low higher
 *    than the one before (longs; mirrored for shorts). Anything else is
 *    盤整 and the engine stands aside.
 *  - M15 回踩區: the nearest M15 swing low below price within ZONE_ATR of
 *    it; failing that, the M15 EMA20. Nothing within reach → 等待.
 *  - 確認進場: the last closed M15 bar touched the zone and closed back on
 *    the trade's side. The paper fill is that close, not the zone.
 *  - 停損: STOP_BUFFER_ATR below the zone, clamped to [MIN, MAX] ATR —
 *    the lab's own terms.
 *  - 停利: the nearest swing high (M15, then H1) at least MIN_RR away; one
 *    closer than that is an obstacle and the setup waits; none at all →
 *    2R, which the manage rules trail anyway.
 *  - 回測: the same managed walk over the M15 history, confirm style, the
 *    lab's veto floors. It can only withhold.
 *
 * Pure. Nothing here fetches, times, or notifies.
 */

export const H1_MIN_BARS = 60;
export const M15_MIN_BARS = 120;
export const ZONE_ATR = 2.0;
export const TOUCH_ATR = 0.3;
export const MIN_RR = 1.5;
export const DEFAULT_RR = 2.0;
export const INTRADAY_HORIZON = 20;
export const INTRADAY_ENTRY_STYLE = "confirm" as const;

export interface IntradaySignal {
  symbol: string;
  pair: string;
  /** Last closed M15 bar. */
  barTime: string;
  direction: "long" | "short" | null;
  stance: "enter" | "wait" | "no-trade";
  background: string;
  zone: number | null;
  /** Paper fill: the confirming close. Null unless entering. */
  entry: number | null;
  stop: number | null;
  target: number | null;
  atr15: number | null;
  riskReward: number | null;
  reasons: { entry: string; stop: string; target: string };
  backtest: PlanBacktest | null;
  /** One line: what to do and why. */
  verdict: string;
  lastClose: number | null;
}

const r = (n: number) => Math.round(n * 10000) / 10000;

function last<T>(xs: T[], n = 1): T | undefined {
  return xs[xs.length - n];
}

/** Adjacent swings of one type at the same price are one swing (a flat-bottomed dip prints two). */
function dedupeSwings<T extends { type: string; price: number }>(points: T[]): T[] {
  const out: T[] = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (prev && prev.type === p.type && prev.price === p.price) continue;
    out.push(p);
  }
  return out;
}

function background(h1: Candle[]): { direction: "long" | "short" | null; text: string } {
  const closes = h1.map((c) => c.close);
  const e20 = last(ema(closes, 20))!;
  const e50 = last(ema(closes, 50))!;
  const close = last(closes)!;
  const swings = dedupeSwings(findSwingPoints(h1, 3));
  const lows = swings.filter((s) => s.type === "low").slice(-2);
  const highs = swings.filter((s) => s.type === "high").slice(-2);
  const hl = lows.length === 2 && lows[1].price > lows[0].price;
  const lh = highs.length === 2 && highs[1].price < highs[0].price;
  if (close > e20 && e20 > e50 && hl) {
    return { direction: "long", text: `H1 多頭：收盤 ${r(close)} > EMA20 ${r(e20)} > EMA50 ${r(e50)}，低點抬升（${r(lows[0].price)} → ${r(lows[1].price)}）` };
  }
  if (close < e20 && e20 < e50 && lh) {
    return { direction: "short", text: `H1 空頭：收盤 ${r(close)} < EMA20 ${r(e20)} < EMA50 ${r(e50)}，高點降低（${r(highs[0].price)} → ${r(highs[1].price)}）` };
  }
  return { direction: null, text: `H1 盤整或結構不明：收盤 ${r(close)}，EMA20 ${r(e20)}，EMA50 ${r(e50)}` };
}

export function analyzeIntraday(input: {
  symbol: string;
  pair: string;
  h1: Candle[] | null;
  m15: Candle[] | null;
}): IntradaySignal {
  const { symbol, pair } = input;
  const base: IntradaySignal = {
    symbol, pair, barTime: "", direction: null, stance: "no-trade", background: "", zone: null, entry: null, stop: null, target: null,
    atr15: null, riskReward: null, reasons: { entry: "", stop: "", target: "" }, backtest: null, verdict: "", lastClose: null,
  };
  const h1 = input.h1 ?? [];
  const m15 = input.m15 ?? [];
  if (h1.length < H1_MIN_BARS || m15.length < M15_MIN_BARS) {
    return { ...base, verdict: `K 棒不足（H1 ${h1.length}/${H1_MIN_BARS}，M15 ${m15.length}/${M15_MIN_BARS}）` };
  }
  const bar = last(m15)!;
  const close = bar.close;
  const atr15 = computeAtr(m15, 14);
  const bg = background(h1);
  if (!atr15 || !(atr15 > 0)) return { ...base, barTime: bar.time, lastClose: close, background: bg.text, verdict: "ATR 無法計算" };
  if (bg.direction === null) {
    return { ...base, barTime: bar.time, lastClose: close, atr15: r(atr15), background: bg.text, verdict: "H1 沒有方向，不做日內" };
  }
  const long = bg.direction === "long";
  const dir = bg.direction;

  // 回踩區
  const swings15 = dedupeSwings(findSwingPoints(m15.slice(-80), 2));
  const offset = m15.length - Math.min(80, m15.length);
  const candidates = swings15
    .filter((s) => (long ? s.type === "low" && s.price < close : s.type === "high" && s.price > close))
    .filter((s) => Math.abs(close - s.price) <= ZONE_ATR * atr15)
    .map((s) => ({ price: s.price, index: s.index + offset, kind: long ? "M15 前低" : "M15 前高" }));
  let zone: { price: number; kind: string } | null = null;
  if (candidates.length > 0) {
    zone = candidates.reduce((best, c) => (long ? (c.price > best.price ? c : best) : (c.price < best.price ? c : best)));
  } else {
    const e20m = last(ema(m15.map((c) => c.close), 20))!;
    if ((long ? e20m < close : e20m > close) && Math.abs(close - e20m) <= ZONE_ATR * atr15) zone = { price: e20m, kind: "M15 EMA20" };
  }
  if (!zone) {
    return { ...base, barTime: bar.time, lastClose: close, direction: dir, stance: "wait", atr15: r(atr15), background: bg.text, verdict: `${long ? "偏多" : "偏空"}但 ${ZONE_ATR} ATR 內沒有回踩區，等` };
  }

  // 停損
  const structureStop = long ? zone.price - STOP_BUFFER_ATR * atr15 : zone.price + STOP_BUFFER_ATR * atr15;
  const minStop = long ? zone.price - MIN_STOP_ATR * atr15 : zone.price + MIN_STOP_ATR * atr15;
  const maxStop = long ? zone.price - MAX_STOP_ATR * atr15 : zone.price + MAX_STOP_ATR * atr15;
  const stop = long ? Math.max(maxStop, Math.min(minStop, structureStop)) : Math.min(maxStop, Math.max(minStop, structureStop));
  const risk = Math.abs(zone.price - stop);

  // 停利
  const swingsH1 = dedupeSwings(findSwingPoints(h1.slice(-80), 3));
  const aheadM15 = swings15.filter((s) => (long ? s.type === "high" && s.price > close : s.type === "low" && s.price < close)).map((s) => ({ price: s.price, kind: long ? "M15 前高" : "M15 前低" }));
  const aheadH1 = swingsH1.filter((s) => (long ? s.type === "high" && s.price > close : s.type === "low" && s.price < close)).map((s) => ({ price: s.price, kind: long ? "H1 前高" : "H1 前低" }));
  const ahead = [...aheadM15, ...aheadH1].sort((a, b) => (long ? a.price - b.price : b.price - a.price));
  const nearest = ahead[0] ?? null;
  let target: number;
  let targetReason: string;
  const nearestRR = nearest ? Math.abs(nearest.price - zone.price) / risk : null;
  if (nearest && nearestRR !== null && nearestRR < MIN_RR) {
    return {
      ...base, barTime: bar.time, lastClose: close, direction: dir, stance: "wait", atr15: r(atr15), background: bg.text, zone: r(zone.price), stop: r(stop),
      reasons: { entry: `${zone.kind} ${r(zone.price)}`, stop: `${zone.kind}外 ${STOP_BUFFER_ATR} ATR`, target: `${nearest.kind} ${r(nearest.price)} 只有 ${Math.round(nearestRR * 100) / 100}R，空間不足` },
      verdict: `回踩區 ${r(zone.price)} 可用，但前方 ${nearest.kind} ${r(nearest.price)} 太近（${Math.round(nearestRR * 100) / 100}R < ${MIN_RR}R），等`,
    };
  }
  if (nearest && nearestRR !== null) {
    target = nearest.price;
    targetReason = `${nearest.kind} ${r(nearest.price)}（${Math.round(nearestRR * 100) / 100}R）`;
  } else {
    target = long ? zone.price + DEFAULT_RR * risk : zone.price - DEFAULT_RR * risk;
    targetReason = `前方無結構，取 ${DEFAULT_RR}R（移停會接手）`;
  }

  const backtest = backtestPlanGeometry(dir, zone.price, stop, target, m15, INTRADAY_HORIZON, symbol, INTRADAY_ENTRY_STYLE);
  const vetoed =
    backtest !== null &&
    backtest.resolved >= 10 &&
    ((backtest.hitRate !== null && backtest.hitRate < TRADE_VETO_HIT_RATE) || (backtest.expectancyR !== null && backtest.expectancyR <= TRADE_VETO_EXPECTANCY_R));

  // 確認進場：最後一根收盤的 M15 觸及回踩區並收回同側。
  const touched = long ? bar.low <= zone.price + TOUCH_ATR * atr15 : bar.high >= zone.price - TOUCH_ATR * atr15;
  const confirmed = long ? bar.close > zone.price : bar.close < zone.price;
  const rr = Math.round((Math.abs(target - zone.price) / risk) * 100) / 100;
  const reasons = {
    entry: `${zone.kind} ${r(zone.price)}，觸及後 M15 收回${long ? "之上" : "之下"}再進`,
    stop: `${zone.kind}外 ${STOP_BUFFER_ATR} ATR（${r(stop)}，${Math.round((risk / atr15) * 100) / 100} ATR）`,
    target: targetReason,
  };
  const common = { ...base, barTime: bar.time, lastClose: close, direction: dir, atr15: r(atr15), background: bg.text, zone: r(zone.price), stop: r(stop), target: r(target), riskReward: rr, reasons, backtest };
  if (vetoed) {
    return { ...common, stance: "wait", verdict: `回測否決：${backtest!.resolved} 筆勝率 ${backtest!.hitRate === null ? "—" : Math.round(backtest!.hitRate * 100) + "%"}、期望值 ${backtest!.expectancyR}R` };
  }
  if (touched && confirmed) {
    return { ...common, stance: "enter", entry: r(close), verdict: `回踩 ${zone.kind} ${r(zone.price)} 並收回，${long ? "做多" : "做空"} @ ${r(close)}，停損 ${r(stop)}，目標 ${r(target)}（1:${rr}）` };
  }
  return { ...common, stance: "wait", verdict: touched ? `已觸及 ${zone.kind} ${r(zone.price)}，等 M15 收回${long ? "之上" : "之下"}` : `等回踩 ${zone.kind} ${r(zone.price)}（距 ${Math.round((Math.abs(close - zone.price) / atr15) * 100) / 100} ATR）` };
}

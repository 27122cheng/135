import type { Candle } from "../data-sources/ohlcv";

export function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(values.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function rsi(values: number[], period = 14): number[] {
  if (values.length < period + 1) return [];
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    gains.push(Math.max(change, 0));
    losses.push(Math.max(-change, 0));
  }
  const out: number[] = [];
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return out;
}

export interface MacdResult {
  macdLine: number[];
  signalLine: number[];
  histogram: number[];
}

export function macd(values: number[], fast = 12, slow = 26, signal = 9): MacdResult {
  if (values.length < slow + signal) return { macdLine: [], signalLine: [], histogram: [] };
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = ema(macdLine, signal);
  const histogram = macdLine.map((v, i) => v - signalLine[i]);
  return { macdLine, signalLine, histogram };
}

export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(
      Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prevClose),
        Math.abs(cur.low - prevClose),
      ),
    );
  }
  const slice = trs.slice(trs.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export interface SwingPoint {
  index: number;
  price: number;
  type: "high" | "low";
  time: string;
}

/** Simple fractal pivot: a bar higher/lower than `lookback` bars on both sides. */
export function findSwingPoints(candles: Candle[], lookback = 2): SwingPoint[] {
  const points: SwingPoint[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const window = candles.slice(i - lookback, i + lookback + 1);
    const c = candles[i];
    if (c.high === Math.max(...window.map((w) => w.high))) {
      points.push({ index: i, price: c.high, type: "high", time: c.time });
    }
    if (c.low === Math.min(...window.map((w) => w.low))) {
      points.push({ index: i, price: c.low, type: "low", time: c.time });
    }
  }
  return points;
}

/** Counts how many candles' high/low come within `tolerancePct` of `price` — used as EntryStructure.strength. */
export function countTouches(candles: Candle[], price: number, tolerancePct: number): number {
  const tol = (price * tolerancePct) / 100;
  let count = 0;
  for (const c of candles) {
    if (Math.abs(c.high - price) <= tol || Math.abs(c.low - price) <= tol) count++;
  }
  return count;
}

export function strengthFromTouches(touches: number): 1 | 2 | 3 {
  if (touches >= 4) return 3;
  if (touches >= 2) return 2;
  return 1;
}

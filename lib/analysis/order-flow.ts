import type { BiasItem, EntryStructure } from "@/types/signal";
import type { Candle } from "../data-sources/ohlcv";

/**
 * 訂單流（bar-based order flow）— who was pushing, read from the bars we have.
 *
 * Real order flow needs the tape: bid/ask volume per price, a footprint, a
 * cumulative delta built from executed trades. The free feeds here give OHLCV
 * bars, so everything below is the standard bar approximation and is labelled
 * as such wherever it is shown:
 *
 *   delta ≈ volume × CLV,  CLV = ((close − low) − (high − close)) / (high − low)
 *
 * A bar that closes near its high on volume is read as net buying; near its
 * low, net selling. Summed, that is a cumulative volume delta (CVD) the same
 * shape a tape-built one has at this resolution, and it supports the four
 * reads a desk actually uses:
 *
 *  1. **CVD 方向** — is the delta trending with price or against it.
 *  2. **背離** — price makes a higher high while CVD makes a lower high (or
 *     the mirror): the move is not being paid for.
 *  3. **吸收** — a high-volume, small-range bar at a known structure: someone
 *     absorbed the hit, which is what makes a level a level.
 *  4. **高潮** — a 2× volume, 1.5× range bar closing at its extreme: the
 *     participation spike that ends moves as often as it starts them, so it
 *     is reported at weight 0 and never votes.
 *  5. **回檔量** — counter-trend bars on lighter volume than trend bars is the
 *     healthy pullback the playbook wants to buy; heavier is distribution.
 *
 * FX and spot gold have no consolidated volume. There the delta falls back to
 * true-range × CLV — effort without participation — and every item is weight
 * 0: the shape is shown, it does not vote. The summary says so in words.
 */

export interface OrderFlowSummary {
  timeframe: "H4" | "D1";
  /** `volume` when the bars carry it; `range-proxy` otherwise (no vote). */
  source: "volume" | "range-proxy";
  bars: number;
  /** Last bar's CLV, −1..1. */
  lastClv: number;
  /** CVD change over the last CVD_RECENT bars as a share of their total effort, −1..1. */
  cvdRecent: number;
  cvdTrend: "up" | "down" | "flat";
  divergence: "bearish" | "bullish" | null;
  absorption: { price: number; structure: string; role: "support" | "resistance"; volRatio: number } | null;
  climax: { kind: "buying" | "selling"; time: string; volRatio: number } | null;
  /** Mean volume of counter-trend bars ÷ mean volume of with-trend bars; null without a trend. */
  pullbackVolumeRatio: number | null;
  trend: "up" | "down" | null;
  lines: string[];
}

export interface OrderFlowResult {
  items: BiasItem[];
  summary: OrderFlowSummary | null;
}

export const OF_WINDOW = 30;
export const CVD_RECENT = 10;
const CVD_FLAT = 0.15;
const ABSORB_VOL = 1.5;
const ABSORB_RANGE = 0.6;
const CLIMAX_VOL = 2.0;
const CLIMAX_RANGE = 1.5;
const PULLBACK_LIGHT = 0.8;
const PULLBACK_HEAVY = 1.2;

const r2 = (n: number) => Math.round(n * 100) / 100;

function clv(c: Candle): number {
  const range = c.high - c.low;
  if (!(range > 0)) return 0;
  return ((c.close - c.low) - (c.high - c.close)) / range;
}

function trueRange(c: Candle, prev: Candle | undefined): number {
  const hl = c.high - c.low;
  if (!prev) return hl;
  return Math.max(hl, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
}

function hasVolume(bars: Candle[]): boolean {
  const withVol = bars.filter((b) => typeof b.volume === "number" && b.volume > 0).length;
  return withVol >= Math.min(20, Math.floor(bars.length * 0.8));
}

function mean(xs: number[]): number {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function analyzeOrderFlow(
  candlesByTf: { H4?: Candle[]; D1?: Candle[] },
  entryStructures: EntryStructure[],
  atr: number | null,
  gaps: string[],
): OrderFlowResult {
  const pick: ["H4" | "D1", Candle[] | undefined][] = [["H4", candlesByTf.H4], ["D1", candlesByTf.D1]];
  const chosen = pick.find(([, c]) => c && c.length >= 20);
  if (!chosen) {
    gaps.push("K 棒不足 20 根，無法計算訂單流");
    return { items: [], summary: null };
  }
  const [timeframe, all] = chosen as ["H4" | "D1", Candle[]];
  const bars = all.slice(-OF_WINDOW);
  const source: OrderFlowSummary["source"] = hasVolume(bars) ? "volume" : "range-proxy";
  const effort = bars.map((b, i) =>
    source === "volume" ? (b.volume ?? 0) : trueRange(b, i > 0 ? bars[i - 1] : all[all.length - bars.length - 1]),
  );
  const delta = bars.map((b, i) => effort[i] * clv(b));
  const cvd: number[] = [];
  delta.reduce((acc, d, i) => { cvd[i] = acc + d; return cvd[i]; }, 0);

  const recentDelta = delta.slice(-CVD_RECENT).reduce((a, b) => a + b, 0);
  const recentEffort = effort.slice(-CVD_RECENT).reduce((a, b) => a + b, 0);
  const cvdRecent = recentEffort > 0 ? r2(recentDelta / recentEffort) : 0;
  const cvdTrend: OrderFlowSummary["cvdTrend"] = cvdRecent > CVD_FLAT ? "up" : cvdRecent < -CVD_FLAT ? "down" : "flat";

  // Divergence: compare the newest CVD_RECENT bars' extreme with the earlier window's.
  const split = bars.length - CVD_RECENT;
  const idxMax = (from: number, to: number, f: (b: Candle) => number) => {
    let best = from;
    for (let i = from; i < to; i++) if (f(bars[i]) > f(bars[best])) best = i;
    return best;
  };
  const idxMin = (from: number, to: number, f: (b: Candle) => number) => {
    let best = from;
    for (let i = from; i < to; i++) if (f(bars[i]) < f(bars[best])) best = i;
    return best;
  };
  let divergence: OrderFlowSummary["divergence"] = null;
  if (split >= 5) {
    const hiOld = idxMax(0, split, (b) => b.high);
    const hiNew = idxMax(split, bars.length, (b) => b.high);
    if (bars[hiNew].high > bars[hiOld].high && cvd[hiNew] < cvd[hiOld]) divergence = "bearish";
    const loOld = idxMin(0, split, (b) => b.low);
    const loNew = idxMin(split, bars.length, (b) => b.low);
    if (bars[loNew].low < bars[loOld].low && cvd[loNew] > cvd[loOld]) divergence = divergence ?? "bullish";
  }

  const avgEffort = mean(effort);
  const avgRange = mean(bars.map((b) => b.high - b.low));
  const near = atr !== null && atr > 0 ? atr * 0.5 : avgRange * 0.5;

  // Absorption: a heavy, narrow bar touching a known structure, in the last CVD_RECENT bars.
  let absorption: OrderFlowSummary["absorption"] = null;
  if (source === "volume") {
    for (let i = bars.length - 1; i >= split && absorption === null; i--) {
      const b = bars[i];
      const volRatio = avgEffort > 0 ? effort[i] / avgEffort : 0;
      const range = b.high - b.low;
      if (volRatio < ABSORB_VOL || !(range <= ABSORB_RANGE * avgRange)) continue;
      const hit = entryStructures.find((s) =>
        s.role === "support" ? Math.abs(b.low - s.price) <= near : Math.abs(b.high - s.price) <= near,
      );
      if (hit) absorption = { price: hit.price, structure: `${hit.timeframe} ${hit.type}`, role: hit.role, volRatio: r2(volRatio) };
    }
  }

  // Climax: in the last 5 bars.
  let climax: OrderFlowSummary["climax"] = null;
  for (let i = bars.length - 1; i >= Math.max(0, bars.length - 5) && climax === null; i--) {
    const b = bars[i];
    const volRatio = avgEffort > 0 ? effort[i] / avgEffort : 0;
    const range = b.high - b.low;
    const c = clv(b);
    if (volRatio >= CLIMAX_VOL && range >= CLIMAX_RANGE * avgRange && Math.abs(c) >= 0.5) {
      climax = { kind: c > 0 ? "buying" : "selling", time: b.time, volRatio: r2(volRatio) };
    }
  }

  // Pullback volume: trend by close vs the window's first close and the share of up bars.
  const first = bars[0].close;
  const last = bars[bars.length - 1].close;
  const trend: OrderFlowSummary["trend"] =
    avgRange > 0 && Math.abs(last - first) >= 2 * avgRange ? (last > first ? "up" : "down") : null;
  let pullbackVolumeRatio: number | null = null;
  if (trend && source === "volume") {
    const withTrend: number[] = [];
    const counter: number[] = [];
    bars.forEach((b, i) => {
      const up = b.close >= b.open;
      ((trend === "up") === up ? withTrend : counter).push(effort[i]);
    });
    if (withTrend.length >= 5 && counter.length >= 3 && mean(withTrend) > 0) {
      pullbackVolumeRatio = r2(mean(counter) / mean(withTrend));
    }
  }

  const items: BiasItem[] = [];
  const lines: string[] = [];
  const vote = (w: 0 | 1 | 2): 0 | 1 | 2 => (source === "volume" ? w : 0);
  const src = source === "volume" ? `${timeframe} 成交量` : `${timeframe} 振幅代理（無成交量）`;
  const proxyNote = source === "range-proxy" ? "；此商品無集中成交量，以振幅×收盤位置代理，只顯示不投票" : "";

  if (cvdTrend !== "flat") {
    const dir = cvdTrend === "up" ? "long" : "short";
    items.push({
      dimension: "籌碼面",
      factor: `訂單流 CVD 近 ${CVD_RECENT} 根${cvdTrend === "up" ? "淨買" : "淨賣"}（${cvdRecent > 0 ? "+" : ""}${cvdRecent}）`,
      direction: dir,
      weight: vote(1),
      evidence: `近 ${CVD_RECENT} 根 delta 合計占總量 ${Math.round(cvdRecent * 100)}%${proxyNote}`,
      source: src,
      key: "orderflow-cvd",
    });
  }
  lines.push(`CVD 近 ${CVD_RECENT} 根：${cvdTrend === "up" ? "淨買" : cvdTrend === "down" ? "淨賣" : "持平"}（${cvdRecent > 0 ? "+" : ""}${cvdRecent}），最新一根收盤位置 ${r2(clv(bars[bars.length - 1]))}`);

  if (divergence) {
    items.push({
      dimension: "籌碼面",
      factor: divergence === "bearish" ? "訂單流頂背離：價格創高、CVD 未創高" : "訂單流底背離：價格創低、CVD 未創低",
      direction: divergence === "bearish" ? "short" : "long",
      weight: vote(1),
      evidence: `近 ${CVD_RECENT} 根的極值對上前 ${split} 根的極值${proxyNote}`,
      source: src,
      key: "orderflow-divergence",
    });
    lines.push(divergence === "bearish" ? "頂背離：新高沒有買盤跟上" : "底背離：新低沒有賣壓跟上");
  }

  if (absorption) {
    items.push({
      dimension: "籌碼面",
      factor: `${absorption.structure} ${absorption.price} 出現吸收（量 ${absorption.volRatio}×、窄幅）`,
      direction: absorption.role === "support" ? "long" : "short",
      weight: 1,
      evidence: `高量窄幅 K 棒貼在${absorption.role === "support" ? "支撐" : "壓力"}上：打進來的單被吃掉`,
      source: src,
      key: "orderflow-absorption",
    });
    lines.push(`吸收：${absorption.structure} ${absorption.price}（量 ${absorption.volRatio}× 均量）`);
  }

  if (climax) {
    items.push({
      dimension: "籌碼面",
      factor: `${climax.kind === "buying" ? "買盤" : "賣盤"}高潮（量 ${climax.volRatio}×、寬幅收在極端）`,
      direction: climax.kind === "buying" ? "short" : "long",
      weight: 0,
      evidence: `高潮常是一段行情的尾聲也可能是起點，只提醒不投票（${climax.time.slice(0, 16)}）`,
      source: src,
      key: "orderflow-climax",
    });
    lines.push(`${climax.kind === "buying" ? "買盤" : "賣盤"}高潮 ${climax.volRatio}× 均量，留意反轉`);
  }

  if (trend && pullbackVolumeRatio !== null) {
    const dir = trend === "up" ? "long" : "short";
    if (pullbackVolumeRatio <= PULLBACK_LIGHT) {
      items.push({
        dimension: "籌碼面",
        factor: `回檔量縮（逆勢 K 棒量為順勢的 ${pullbackVolumeRatio}×）`,
        direction: dir,
        weight: 1,
        evidence: "回檔沒有人在賣／買，是健康的回踩",
        source: src,
        key: "orderflow-pullback",
      });
      lines.push(`回檔量縮 ${pullbackVolumeRatio}×：健康回踩`);
    } else if (pullbackVolumeRatio >= PULLBACK_HEAVY) {
      items.push({
        dimension: "籌碼面",
        factor: `回檔放量（逆勢 K 棒量為順勢的 ${pullbackVolumeRatio}×）`,
        direction: dir === "long" ? "short" : "long",
        weight: 1,
        evidence: "逆勢 K 棒比順勢更有人參與：派發／吸籌的跡象",
        source: src,
        key: "orderflow-pullback",
      });
      lines.push(`回檔放量 ${pullbackVolumeRatio}×：逆勢有人參與`);
    } else {
      lines.push(`回檔量 ${pullbackVolumeRatio}× 順勢量：無明顯訊號`);
    }
  }
  if (source === "range-proxy") lines.push("無集中成交量：以振幅×收盤位置代理，只顯示、不投票");

  return {
    items,
    summary: {
      timeframe, source, bars: bars.length, lastClv: r2(clv(bars[bars.length - 1])), cvdRecent, cvdTrend,
      divergence, absorption, climax, pullbackVolumeRatio, trend, lines,
    },
  };
}

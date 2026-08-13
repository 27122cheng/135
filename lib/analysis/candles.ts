import type { BiasItem, EntryStructure, Timeframe } from "@/types/signal";
import type { Candle } from "../data-sources/ohlcv";

/**
 * 裸K反轉訊號 — single/two-bar price action, anchored to structure.
 *
 * ## The rule that shapes everything
 *
 * A candle shape on its own is not evidence. A hammer in the middle of
 * nowhere is a hammer in the middle of nowhere; the same hammer whose wick
 * just tested a level the analysis already named a support is a rejection of
 * that level, and *that* is worth a vote. So a detected signal only carries
 * weight when the bar's extreme actually engaged a same-side structure —
 * otherwise it is recorded (weight 0) so the card can say what was seen,
 * without letting geometry vote in a vacuum. This mirrors the chart-pattern
 * module's discipline, where a breakout is nothing until the retest holds.
 *
 * ## Only closed bars
 *
 * Detection runs on the last *completed* bar (index -2). The newest element
 * of a feed is usually still forming, and a forming bar's shape is a
 * coin-flip in progress — an "engulfing" that un-engulfs itself by the close
 * would have voted and then vanished on the next scan.
 *
 * Every threshold is in ATR or in body-ratios, never in price or percent —
 * same reasoning as the pattern scanner: a fixed percentage means four
 * different things across nine instruments.
 */

/** The bar's wick must have come within this of the level to count as a test. */
const ANCHOR_ATR = 0.8;
/** An engulfing body this small is noise even if the geometry qualifies. */
const MIN_ENGULF_BODY_ATR = 0.5;
/** A pin bar needs a real bar behind it. */
const MIN_PIN_RANGE_ATR = 0.8;
/** Pin: the rejection wick must be at least this multiple of the body. */
const PIN_WICK_TO_BODY = 2;

interface Shape {
  name: string;
  direction: "long" | "short";
  /** What the shape claims, for the evidence line. */
  claim: string;
}

function shapeOf(prev: Candle, cur: Candle, atr: number): Shape | null {
  const body = Math.abs(cur.close - cur.open);
  const range = cur.high - cur.low;
  if (range <= 0) return null;
  const upper = cur.high - Math.max(cur.open, cur.close);
  const lower = Math.min(cur.open, cur.close) - cur.low;

  // Engulfing: this bar's body swallows the previous bar's body, in reverse.
  const prevBearish = prev.close < prev.open;
  const prevBullish = prev.close > prev.open;
  if (
    prevBearish &&
    cur.close > cur.open &&
    cur.open <= prev.close &&
    cur.close >= prev.open &&
    body >= MIN_ENGULF_BODY_ATR * atr
  ) {
    return { name: "看漲吞噬", direction: "long", claim: "陽線實體完整包覆前一根陰線實體" };
  }
  if (
    prevBullish &&
    cur.close < cur.open &&
    cur.open >= prev.close &&
    cur.close <= prev.open &&
    body >= MIN_ENGULF_BODY_ATR * atr
  ) {
    return { name: "看跌吞噬", direction: "short", claim: "陰線實體完整包覆前一根陽線實體" };
  }

  // Pin bars: one long rejection wick, small body, small opposite wick.
  if (range >= MIN_PIN_RANGE_ATR * atr && body > 0) {
    if (lower >= PIN_WICK_TO_BODY * body && upper <= body) {
      return { name: "錘子（下影線拒絕）", direction: "long", claim: "長下影線收回，賣壓被吸收" };
    }
    if (upper >= PIN_WICK_TO_BODY * body && lower <= body) {
      return { name: "射擊之星（上影線拒絕）", direction: "short", claim: "長上影線收回，買盤被拒絕" };
    }
  }

  return null;
}

/**
 * The structure the bar actually tested, if any: a support for a long signal
 * (the wick's low reached it), a resistance for a short one.
 */
function anchoredTo(
  shape: Shape,
  cur: Candle,
  structures: EntryStructure[],
  atr: number,
): EntryStructure | null {
  const wick = shape.direction === "long" ? cur.low : cur.high;
  const wanted = shape.direction === "long" ? "support" : "resistance";
  let best: EntryStructure | null = null;
  for (const s of structures) {
    if (s.role !== wanted) continue;
    const dist = Math.abs(wick - s.price);
    if (dist > ANCHOR_ATR * atr) continue;
    if (!best || dist < Math.abs(wick - best.price)) best = s;
  }
  return best;
}

function fmt(n: number): string {
  return Math.abs(n) < 10 ? n.toFixed(5) : n.toFixed(2);
}

/**
 * Reversal-candle bias items for one timeframe's feed.
 *
 * At most one item per timeframe — the newest closed bar either is or isn't
 * a signal. Anchored to structure: weight 1. Unanchored: weight 0, still
 * shown, explicitly labelled as not voting.
 */
export function candleSignals(
  timeframe: Timeframe,
  candles: Candle[] | undefined,
  atr: number | null,
  structures: EntryStructure[],
): BiasItem[] {
  if (!candles || candles.length < 3 || !atr || atr <= 0) return [];
  // -2/-3: the newest bar is usually still forming; only closed bars testify.
  const cur = candles[candles.length - 2];
  const prev = candles.length >= 3 ? candles[candles.length - 3] : null;
  if (!prev) return [];

  const shape = shapeOf(prev, cur, atr);
  if (!shape) return [];

  const anchor = anchoredTo(shape, cur, structures, atr);
  return [
    {
      dimension: "技術面",
      factor: anchor
        ? `${timeframe} ${shape.name} @ ${anchor.timeframe} ${anchor.type} ${fmt(anchor.price)}（結構位反轉K棒）`
        : `${timeframe} ${shape.name}（不在關鍵結構附近，僅記錄不投票）`,
      direction: anchor ? shape.direction : "neutral",
      weight: anchor ? 1 : 0,
      evidence:
        `${shape.claim}；O${fmt(cur.open)} H${fmt(cur.high)} L${fmt(cur.low)} C${fmt(cur.close)}` +
        (anchor ? `；影線觸及 ${anchor.type} ${fmt(anchor.price)}（容差 ${ANCHOR_ATR}×ATR）` : ""),
      source: `${timeframe} 已收盤K棒 ${cur.time}（裸K訊號）`,
    },
  ];
}

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
/**
 * 假突破 — Spring（假跌破）與 Upthrust（假突破）.
 *
 * A wick that pierces a level and closes back on the original side is the
 * market rejecting the break: stops beyond the level were taken, the move
 * failed, and the side that defended it is left holding the field. Of every
 * shape in this file it is the one with the strongest claim to an edge,
 * because it is not a shape at all — it is the *outcome* of a fight over a
 * level the analysis already named.
 *
 * Stricter than a pin bar in two ways that matter: the pierce must be a
 * genuine break of the level (not merely near it), and the *current* price
 * must still be on the defending side — a spring whose level has since given
 * way is not a spring, it is a breakdown with an ugly first bar. Looks back
 * three closed bars, because the retest that confirms it takes a bar or two.
 */
export function falseBreakSignal(
  timeframe: Timeframe,
  candles: Candle[] | undefined,
  atr: number | null,
  structures: EntryStructure[],
): BiasItem | null {
  if (!candles || candles.length < 5 || !atr || atr <= 0) return null;
  // Newest bar is still forming; examine the three closed bars before it.
  const closed = candles.slice(0, -1);
  const now = closed[closed.length - 1]?.close;
  if (!Number.isFinite(now)) return null;
  const window = closed.slice(-3);
  // A pierce shallower than this is a level being touched, not broken.
  const minPierce = 0.15 * atr;

  for (let i = window.length - 1; i >= 0; i--) {
    const bar = window[i];
    for (const s of structures) {
      if (s.role === "support") {
        const pierced = bar.low < s.price - minPierce;
        const recovered = bar.close > s.price && now > s.price;
        if (pierced && recovered) {
          return {
            dimension: "技術面",
            factor: `${timeframe} 假跌破反轉（Spring）：影線刺破 ${s.timeframe} ${s.type} ${fmt(s.price)} 後收回其上`,
            direction: "long",
            weight: 2,
            evidence:
              `最低 ${fmt(bar.low)} 跌破 ${fmt(s.price)}（穿刺 ${fmt(s.price - bar.low)}，門檻 0.15×ATR），` +
              `收盤 ${fmt(bar.close)} 收回支撐之上，現價 ${fmt(now)} 仍在其上 —— 掃停損洗盤特徵`,
            source: `${timeframe} 已收盤K棒 ${bar.time}（假突破偵測）`,
          };
        }
      } else if (s.role === "resistance") {
        const pierced = bar.high > s.price + minPierce;
        const recovered = bar.close < s.price && now < s.price;
        if (pierced && recovered) {
          return {
            dimension: "技術面",
            factor: `${timeframe} 假突破回落（Upthrust）：影線刺穿 ${s.timeframe} ${s.type} ${fmt(s.price)} 後收回其下`,
            direction: "short",
            weight: 2,
            evidence:
              `最高 ${fmt(bar.high)} 突破 ${fmt(s.price)}（穿刺 ${fmt(bar.high - s.price)}，門檻 0.15×ATR），` +
              `收盤 ${fmt(bar.close)} 收回壓力之下，現價 ${fmt(now)} 仍在其下 —— 誘多出貨特徵`,
            source: `${timeframe} 已收盤K棒 ${bar.time}（假突破偵測）`,
          };
        }
      }
    }
  }
  return null;
}

/**
 * 未回補跳空 — the cleanest support/resistance there is, because nobody
 * traded inside it.
 *
 * For FX the weekend gap is the case that matters: Friday's close to
 * Sunday's open is a price range the market skipped, and it tends to be
 * revisited. Reported as a non-voting fact rather than a direction: a gap
 * is a magnet, not a bias — price being pulled back into it is bullish for
 * a gap below and bearish for one above, which are opposite conclusions
 * from the same object. What it changes is where the levels are, so it is
 * surfaced for the reader and for the path obstacles, not for the vote.
 */
export function unfilledGapSignal(
  timeframe: Timeframe,
  candles: Candle[] | undefined,
  lookback = 60,
): BiasItem | null {
  if (!candles || candles.length < 10) return null;
  const bars = candles.slice(-lookback);
  const price = bars[bars.length - 1].close;

  interface Gap {
    type: "up" | "down";
    top: number;
    bottom: number;
    time: string;
    index: number;
  }
  const gaps: Gap[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const p = bars[i - 1];
    // 0.05% floor: below that it is a tick, not a gap.
    if (b.low > p.high * 1.0005) {
      gaps.push({ type: "up", top: b.low, bottom: p.high, time: b.time, index: i });
    } else if (b.high < p.low * 0.9995) {
      gaps.push({ type: "down", top: p.low, bottom: b.high, time: b.time, index: i });
    }
  }
  const unfilled = gaps.filter((g) => {
    for (let j = g.index + 1; j < bars.length; j++) {
      if (g.type === "up" && bars[j].low <= g.bottom) return false;
      if (g.type === "down" && bars[j].high >= g.top) return false;
    }
    return true;
  });
  if (unfilled.length === 0) return null;

  // The nearest one on each side is what a plan could actually run into.
  const below = unfilled.filter((g) => g.top <= price).sort((a, b) => b.top - a.top)[0];
  const above = unfilled.filter((g) => g.bottom >= price).sort((a, b) => a.bottom - b.bottom)[0];
  const parts: string[] = [];
  if (below) parts.push(`下方 ${fmt(below.bottom)}–${fmt(below.top)}（${below.time.slice(0, 10)}）`);
  if (above) parts.push(`上方 ${fmt(above.bottom)}–${fmt(above.top)}（${above.time.slice(0, 10)}）`);
  if (parts.length === 0) return null;

  return {
    dimension: "技術面",
    factor: `${timeframe} 有 ${unfilled.length} 個未回補跳空缺口，最近的在${parts.join("、")}`,
    direction: "neutral",
    weight: 0,
    evidence:
      "跳空區間內沒有成交，價格常被吸引回來測試；" +
      "方向兩義（下方缺口回補是下跌、上方缺口回補是上漲），故只列為位置資訊不計方向",
    source: `${timeframe} K棒（未回補跳空掃描，回看 ${lookback} 根）`,
  };
}

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

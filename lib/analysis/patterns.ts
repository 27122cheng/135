import type {
  BiasItem,
  ChartPattern,
  EntryStructure,
  PathObstacle,
  PatternCheck,
  PatternName,
  Timeframe,
} from "@/types/signal";
import type { Candle } from "../data-sources/yfinance";
import { atr as computeAtr, findSwingPoints } from "./indicators";

/**
 * 圖形交易 — classical chart patterns, detected geometrically.
 *
 * ## The two rules that shape everything here
 *
 * **A break is not a trade until price comes back and the level holds, with
 * volume behind the break.** That is the owner's rule, and it is the reason
 * this module has a state machine rather than a boolean. A pattern that has
 * broken out is *not* yet tradeable; it sits in `broken_out` until a retest
 * has actually happened and held. Most published pattern scanners fire on the
 * breakout bar, which is precisely the entry that gets stopped out on the
 * throwback.
 *
 * **The target comes from the pattern's own height.** For 頭肩頂/底 the head
 * sets the distance; for a reversal triangle the triangle's extreme does.
 * Taken literally — "put the target *at* the head" — the rule is unusable for
 * an inverse head-and-shoulders, whose head is its lowest point and therefore
 * below a long entry. Read as "the head measures the move", both rules become
 * the same rule, and it is the textbook one: project the pattern's height from
 * the line that was broken.
 *
 * ## What this is not
 *
 * Not an oracle, and not an AI. Every pattern here is a shape test over swing
 * pivots with named thresholds; the same candles always produce the same
 * patterns. Nothing is scored by a model, and no price is invented — every
 * level emitted is a pivot, a fitted boundary through pivots, or a projection
 * whose arithmetic is written on the card.
 *
 * ## V 頂／V 底
 *
 * Left out at first, on the reasoning that a V has no consolidation and
 * therefore nothing to retest. That was wrong. A V's neckline is the swing that
 * preceded the final leg — the base the spike launched from — and price coming
 * back through it is the same confirmation every other pattern gets from its
 * neckline. See `detectV`.
 */

// ── tuning ────────────────────────────────────────────────────────
//
// Every threshold is expressed in ATR or in bars, never in price or percent:
// a 0.5% tolerance is a rounding error on EUR/USD and a whole day's range on
// WTI, and a scanner tuned that way silently means different things per symbol.

/** Pivot lookback. 3 keeps minor noise out without losing real shoulders. */
const PIVOT_LOOKBACK = 3;
/** How far back a pattern may start. Older shapes have stopped mattering. */
const WINDOW_BARS = 120;
/** Two prices are "the same level" within this fraction of ATR. */
const LEVEL_TOL_ATR = 0.6;
/** A boundary is "flat" if it travels less than this × ATR across the pattern. */
const FLAT_ATR = 0.6;
/** Converging if the boundaries close to this fraction of their starting gap. */
const CONVERGE_RATIO = 0.75;
/** Diverging if they open to this multiple of it. */
const DIVERGE_RATIO = 1.3;
/** A pattern needs at least this many bars, or it is noise. */
const MIN_SPAN_BARS = 8;
/** Flags and pennants are short by definition. */
const MAX_FLAG_SPAN = 20;
/** A flagpole: this much movement in ATR over the bars just before the pattern. */
const POLE_ATR = 2.5;
const POLE_LOOKBACK = 12;
/** Volume on the breakout bar must beat the pattern's own average by this. */
const VOLUME_MULTIPLE = 1.5;
/** Bars allowed for the retest to happen before the setup goes stale. */
const RETEST_WINDOW = 12;
/** Range proxy when the instrument has no volume: breakout bar's TR vs ATR. */
const RANGE_PROXY_ATR = 1.5;
/** A V's legs must each be this many ATR, or it is an ordinary swing. */
const V_LEG_ATR = 3;
/** …and travelled in at most this many bars, or it is not a spike. */
const V_MAX_LEG_BARS = 12;
/** The return leg has to give back this much of the first one. */
const V_RETRACE = 0.6;
/** How much slower the return leg may be than the first. */
const V_SYMMETRY = 2.5;

// ── geometry helpers ──────────────────────────────────────────────

interface Point {
  x: number;
  y: number;
}
interface Line {
  slope: number;
  intercept: number;
}

/** Least squares through 2+ points. Two points give the exact line. */
function fitLine(points: Point[]): Line | null {
  if (points.length < 2) return null;
  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  return { slope, intercept: (sumY - slope * sumX) / n };
}

function at(line: Line, x: number): number {
  return line.slope * x + line.intercept;
}

function round(n: number): number {
  return Math.round(n * 100000) / 100000;
}

/** True range of one bar against its predecessor. */
function trueRange(candles: Candle[], i: number): number {
  const c = candles[i];
  if (i === 0) return c.high - c.low;
  const prev = candles[i - 1].close;
  return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
}

// ── confirmation ──────────────────────────────────────────────────

/**
 * Did the breakout bar carry volume?
 *
 * FX has no consolidated volume — the feed reports 0 or null for every bar on
 * EUR/USD — so "含有成交量" is not a test that can be run on three of the nine
 * instruments. Rather than quietly passing them (which would make the rule a
 * no-op exactly where it is easiest to get faked out) or quietly failing them
 * (which would disable patterns on FX entirely), this falls back to range
 * expansion and *says* it did. A breakout bar whose true range is 1.5× ATR is
 * the same claim volume is being asked for — that the break was participated
 * in, not a drift through a line — measured with what the instrument has.
 */
function breakoutParticipation(
  candles: Candle[],
  index: number,
  atr: number,
): PatternCheck {
  const from = Math.max(0, index - 20);
  const vols = candles
    .slice(from, index)
    .map((c) => c.volume)
    .filter((v): v is number => typeof v === "number" && v > 0);
  const breakoutVol = candles[index]?.volume ?? null;

  if (vols.length >= 10 && typeof breakoutVol === "number" && breakoutVol > 0) {
    const avg = vols.reduce((a, b) => a + b, 0) / vols.length;
    const ratio = breakoutVol / avg;
    return {
      label: "突破帶量",
      passed: ratio >= VOLUME_MULTIPLE,
      detail: `突破當根成交量 ${Math.round(breakoutVol).toLocaleString()}，為前 ${vols.length} 根均量的 ${ratio.toFixed(2)} 倍（需 ≥ ${VOLUME_MULTIPLE}）`,
    };
  }

  const tr = trueRange(candles, index);
  const ratio = atr > 0 ? tr / atr : 0;
  return {
    label: "突破帶量（無成交量資料，改用振幅代理）",
    passed: ratio >= RANGE_PROXY_ATR,
    detail:
      `此商品沒有可用的成交量資料（外匯無集中成交量），改判突破當根振幅：` +
      `真實區間 ${round(tr)} = ${ratio.toFixed(2)}×ATR（需 ≥ ${RANGE_PROXY_ATR}）`,
  };
}

interface BreakResult {
  status: ChartPattern["status"];
  checks: PatternCheck[];
  breakIndex: number | null;
}

/**
 * The state machine: forming → broken_out → confirmed, or → failed.
 *
 * `confirmed` is the only status that produces a trade. Reaching it needs all
 * three of the owner's conditions — a close beyond the line, participation on
 * that bar, and a retest that came back to the line and held it. A break that
 * closes back inside is `failed` and is reported as such rather than dropped,
 * because a failed pattern is information: it is the other side getting paid.
 */
function classifyBreak(
  candles: Candle[],
  startIndex: number,
  line: Line,
  direction: "long" | "short",
  atr: number,
): BreakResult {
  const tol = atr * LEVEL_TOL_ATR;
  const checks: PatternCheck[] = [];

  let breakIndex: number | null = null;
  for (let i = startIndex; i < candles.length; i++) {
    const level = at(line, i);
    const beyond =
      direction === "long" ? candles[i].close > level + tol : candles[i].close < level - tol;
    if (beyond) {
      breakIndex = i;
      break;
    }
  }

  if (breakIndex === null) {
    checks.push({
      label: "突破頸線／邊界",
      passed: false,
      detail: `價格仍在型態內，尚未以收盤價站${direction === "long" ? "上" : "下"}邊界（容差 ${round(tol)}）`,
    });
    return { status: "forming", checks, breakIndex: null };
  }

  const level = at(line, breakIndex);
  checks.push({
    label: "突破頸線／邊界",
    passed: true,
    detail: `${candles[breakIndex].time.slice(0, 10)} 收盤 ${round(candles[breakIndex].close)} ${direction === "long" ? "站上" : "跌破"} ${round(level)}`,
  });

  checks.push(breakoutParticipation(candles, breakIndex, atr));

  // The retest. Two things must both happen inside the window: price returns
  // to the line, and a bar closes back on the breakout side afterwards. A
  // return that does not close back is not a hold — it is the break failing.
  let touched = false;
  let held = false;
  let failed = false;
  const last = Math.min(candles.length - 1, breakIndex + RETEST_WINDOW);
  for (let i = breakIndex + 1; i <= last; i++) {
    const l = at(line, i);
    const c = candles[i];
    const reached = direction === "long" ? c.low <= l + tol : c.high >= l - tol;
    if (reached) touched = true;
    const closedBack = direction === "long" ? c.close < l - tol : c.close > l + tol;
    if (closedBack) {
      failed = true;
      break;
    }
    if (touched && (direction === "long" ? c.close > l : c.close < l)) held = true;
  }

  if (failed) {
    checks.push({
      label: "回踩守住",
      passed: false,
      detail: `突破後價格又收回型態內，視為假突破`,
    });
    return { status: "failed", checks, breakIndex };
  }

  checks.push({
    label: "回踩守住",
    passed: touched && held,
    detail: touched
      ? held
        ? `突破後回踩到 ${round(at(line, last))} 附近並收在正確一側，頸線已翻轉為有效${direction === "long" ? "支撐" : "壓力"}`
        : `已回踩但尚未收在正確一側，等待確認`
      : `突破後尚未回踩，依規則不進場——等回踩撐住（最多再等 ${Math.max(0, breakIndex + RETEST_WINDOW - (candles.length - 1))} 根）`,
  });

  const allPassed = checks.every((c) => c.passed);
  return { status: allPassed ? "confirmed" : "broken_out", checks, breakIndex };
}

// ── pattern construction ──────────────────────────────────────────

interface Built {
  name: PatternName;
  kind: ChartPattern["kind"];
  direction: "long" | "short";
  breakLine: Line;
  /** The pattern's far extreme — what measures the move. */
  extreme: number;
  extremeLabel: string;
  invalidation: number;
  startIndex: number;
  /**
   * The first bar that may count as the breakout — the last pivot the shape is
   * built from.
   *
   * Without this the scan starts at the pattern's *beginning*, and a bar inside
   * the shape can be mistaken for the break: a head-and-shoulders' left shoulder
   * often sits at the neckline, so the very first bars would "break" it and the
   * pattern would report a breakout that happened before the head existed.
   */
  breakFrom: number;
  note: string;
}

function finalise(
  built: Built,
  candles: Candle[],
  timeframe: Timeframe,
  atr: number,
): ChartPattern {
  const lastIndex = candles.length - 1;
  const breakLevel = at(built.breakLine, lastIndex);
  const height = Math.abs(built.extreme - at(built.breakLine, built.startIndex));
  const target = built.direction === "long" ? breakLevel + height : breakLevel - height;

  const { status, checks, breakIndex } = classifyBreak(
    candles,
    built.breakFrom,
    built.breakLine,
    built.direction,
    atr,
  );

  const span = lastIndex - built.startIndex;
  const strength: 1 | 2 | 3 = span >= 40 ? 3 : span >= 20 ? 2 : 1;

  return {
    name: built.name,
    kind: built.kind,
    direction: built.direction,
    timeframe,
    breakout_level: round(breakLevel),
    invalidation_level: round(built.invalidation),
    target: round(target),
    target_basis:
      `${built.extremeLabel} ${round(built.extreme)} 距邊界 ${round(height)}，` +
      `自突破位 ${round(breakLevel)} ${built.direction === "long" ? "往上" : "往下"}投射同樣距離`,
    status,
    checks,
    from: candles[built.startIndex]?.time ?? "",
    to: candles[breakIndex ?? lastIndex]?.time ?? "",
    bars: span,
    strength,
    note: built.note,
  };
}

// ── A. peak patterns: head-and-shoulders, double, triple ──────────

interface Pivot {
  index: number;
  price: number;
  type: "high" | "low";
}

/**
 * Turns raw fractal pivots into actual turning points.
 *
 * `findSwingPoints` asks whether a bar's high is the highest in its window,
 * which is true of *every* bar inside a level stretch — twenty quiet bars
 * produce forty pivots, all at the same two prices, and a line fitted through
 * them describes the quiet, not the shape. It also double-counts real turns
 * whose extreme is shared by two adjacent bars.
 *
 * Two passes fix both. A pivot survives only if its window actually has range
 * on the relevant side, and adjacent pivots of the same type collapse to the
 * more extreme one. Everything downstream assumes clean alternating turns, so
 * this runs before any fitting.
 */
function cleanPivots(candles: Candle[], atr: number): Pivot[] {
  const flatEps = atr * 0.05;
  const kept: Pivot[] = [];

  for (const p of findSwingPoints(candles, PIVOT_LOOKBACK)) {
    const from = Math.max(0, p.index - PIVOT_LOOKBACK);
    const to = Math.min(candles.length, p.index + PIVOT_LOOKBACK + 1);
    const side = candles.slice(from, to).map((c) => (p.type === "high" ? c.high : c.low));
    if (Math.max(...side) - Math.min(...side) < flatEps) continue;
    kept.push({ index: p.index, price: p.price, type: p.type });
  }

  const merged: Pivot[] = [];
  for (const p of kept) {
    const last = merged.at(-1);
    if (last && last.type === p.type && p.index - last.index <= PIVOT_LOOKBACK * 2) {
      const better = p.type === "high" ? p.price > last.price : p.price < last.price;
      if (better) merged[merged.length - 1] = p;
      continue;
    }
    merged.push(p);
  }
  return merged;
}

/**
 * Head-and-shoulders and its flat-headed relatives, in one pass.
 *
 * All four are the same shape with a different middle peak: three peaks with
 * a higher middle is a head-and-shoulders, three level peaks is a triple top,
 * two level peaks is a double top. Detecting them together is what keeps the
 * neckline definition — the low(s) between the peaks — identical across them,
 * which matters because the neckline is both the entry trigger and the thing
 * the measured move is projected from.
 */
function detectPeakPatterns(
  pivots: Pivot[],
  candles: Candle[],
  atr: number,
  top: boolean,
): Built[] {
  const tol = atr * LEVEL_TOL_ATR;
  const peaks = pivots.filter((p) => p.type === (top ? "high" : "low"));
  const troughs = pivots.filter((p) => p.type === (top ? "low" : "high"));
  if (peaks.length < 2 || troughs.length < 1) return [];

  const out: Built[] = [];
  const better = (a: number, b: number) => (top ? a > b : a < b);
  const dir: "long" | "short" = top ? "short" : "long";

  const between = (from: number, to: number) =>
    troughs.filter((t) => t.index > from && t.index < to);

  // Three peaks — head-and-shoulders or triple.
  if (peaks.length >= 3) {
    const [p1, p2, p3] = peaks.slice(-3);
    const mid = between(p1.index, p2.index);
    const mid2 = between(p2.index, p3.index);
    if (mid.length > 0 && mid2.length > 0) {
      const shouldersLevel = Math.abs(p1.price - p3.price) <= tol;
      const headStandsOut =
        better(p2.price, p1.price + (top ? tol : -tol)) &&
        better(p2.price, p3.price + (top ? tol : -tol));
      // The neckline runs through the two troughs, so a sloping neckline is
      // handled properly rather than flattened to a single price.
      const necks = [
        mid.reduce((b, t) => (better(t.price, b.price) ? b : t)),
        mid2.reduce((b, t) => (better(t.price, b.price) ? b : t)),
      ];
      const neckline = fitLine(necks.map((t) => ({ x: t.index, y: t.price })));
      if (neckline && shouldersLevel && headStandsOut) {
        out.push({
          name: top ? "頭肩頂" : "頭肩底",
          kind: "reversal",
          direction: dir,
          breakLine: neckline,
          extreme: p2.price,
          extremeLabel: "頭部",
          invalidation: p2.price,
          startIndex: p1.index,
          breakFrom: p3.index,
          note: `左肩 ${round(p1.price)}、頭 ${round(p2.price)}、右肩 ${round(p3.price)}，頸線由兩個${top ? "低" : "高"}點連成。止盈依頭部到頸線的距離投射。`,
        });
      } else if (
        neckline &&
        Math.abs(p1.price - p2.price) <= tol &&
        Math.abs(p2.price - p3.price) <= tol
      ) {
        const extreme = top
          ? Math.max(p1.price, p2.price, p3.price)
          : Math.min(p1.price, p2.price, p3.price);
        out.push({
          name: top ? "三重頂" : "三重底",
          kind: "reversal",
          direction: dir,
          breakLine: neckline,
          extreme,
          extremeLabel: top ? "型態最高點" : "型態最低點",
          invalidation: extreme,
          startIndex: p1.index,
          breakFrom: p3.index,
          note: `三個${top ? "高" : "低"}點 ${round(p1.price)}／${round(p2.price)}／${round(p3.price)} 幾乎同高，頸線 ${round(at(neckline, candles.length - 1))}。`,
        });
      }
    }
  }

  // Two peaks — double top/bottom. Only when the three-peak reading did not
  // already claim these bars, so one shape is not reported twice.
  if (out.length === 0 && peaks.length >= 2) {
    const [p1, p2] = peaks.slice(-2);
    const mid = between(p1.index, p2.index);
    if (mid.length > 0 && Math.abs(p1.price - p2.price) <= tol) {
      const neck = mid.reduce((b, t) => (better(t.price, b.price) ? b : t));
      const extreme = top ? Math.max(p1.price, p2.price) : Math.min(p1.price, p2.price);
      out.push({
        name: top ? "雙重頂" : "雙重底",
        kind: "reversal",
        direction: dir,
        breakLine: { slope: 0, intercept: neck.price },
        extreme,
        extremeLabel: top ? "型態最高點" : "型態最低點",
        invalidation: extreme,
        startIndex: p1.index,
        breakFrom: p2.index,
        note: `兩個${top ? "高" : "低"}點 ${round(p1.price)} 與 ${round(p2.price)} 相差 ${round(Math.abs(p1.price - p2.price))}（容差 ${round(tol)}），頸線 ${round(neck.price)}。`,
      });
    }
  }

  return out;
}

// ── B. two-boundary patterns: triangles, wedges, rectangles… ──────

interface Boundaries {
  highLine: Line;
  lowLine: Line;
  startIndex: number;
  endIndex: number;
  startGap: number;
  endGap: number;
  highs: Pivot[];
  lows: Pivot[];
}

function boundaries(pivots: Pivot[], lastIndex: number): Boundaries | null {
  const highs = pivots.filter((p) => p.type === "high").slice(-4);
  const lows = pivots.filter((p) => p.type === "low").slice(-4);
  if (highs.length < 2 || lows.length < 2) return null;
  const highLine = fitLine(highs.map((p) => ({ x: p.index, y: p.price })));
  const lowLine = fitLine(lows.map((p) => ({ x: p.index, y: p.price })));
  if (!highLine || !lowLine) return null;
  const startIndex = Math.min(highs[0].index, lows[0].index);
  const startGap = at(highLine, startIndex) - at(lowLine, startIndex);
  const endGap = at(highLine, lastIndex) - at(lowLine, lastIndex);
  if (!(startGap > 0)) return null;
  return { highLine, lowLine, startIndex, endIndex: lastIndex, startGap, endGap, highs, lows };
}

/** Movement of a fitted line across the pattern, in ATR. */
function travel(line: Line, from: number, to: number, atr: number): number {
  return atr > 0 ? Math.abs(at(line, to) - at(line, from)) / atr : Infinity;
}

/**
 * A flagpole immediately before the pattern: a directional move of at least
 * POLE_ATR over the preceding bars. This is what separates a flag from a
 * channel and a pennant from a symmetrical triangle — same geometry, different
 * meaning, and the difference is entirely in what came before.
 */
function poleBefore(
  candles: Candle[],
  startIndex: number,
  atr: number,
): "long" | "short" | null {
  const from = Math.max(0, startIndex - POLE_LOOKBACK);
  if (startIndex - from < 3 || atr <= 0) return null;
  const move = candles[startIndex].close - candles[from].close;
  if (Math.abs(move) / atr < POLE_ATR) return null;
  return move > 0 ? "long" : "short";
}

function detectBoundaryPattern(
  pivots: Pivot[],
  candles: Candle[],
  atr: number,
): Built | null {
  const lastIndex = candles.length - 1;
  const b = boundaries(pivots, lastIndex);
  if (!b) return null;
  if (lastIndex - b.startIndex < MIN_SPAN_BARS) return null;

  const highFlat = travel(b.highLine, b.startIndex, lastIndex, atr) < FLAT_ATR;
  const lowFlat = travel(b.lowLine, b.startIndex, lastIndex, atr) < FLAT_ATR;
  const ratio = b.endGap / b.startGap;
  const converging = ratio < CONVERGE_RATIO;
  const diverging = ratio > DIVERGE_RATIO;
  const highUp = b.highLine.slope > 0;
  const lowUp = b.lowLine.slope > 0;

  const patternHigh = Math.max(...b.highs.map((p) => p.price));
  const patternLow = Math.min(...b.lows.map((p) => p.price));
  const span = lastIndex - b.startIndex;
  const pole = poleBefore(candles, b.startIndex, atr);

  // The last pivot on either boundary: everything before it is still the shape
  // being drawn, not a break of it.
  const breakFrom = Math.max(b.highs.at(-1)!.index, b.lows.at(-1)!.index);
  const upper = (): Omit<Built, "name" | "kind" | "note"> => ({
    direction: "long",
    breakLine: b.highLine,
    extreme: patternLow,
    extremeLabel: "型態最低點",
    invalidation: patternLow,
    startIndex: b.startIndex,
    breakFrom,
  });
  const lower = (): Omit<Built, "name" | "kind" | "note"> => ({
    direction: "short",
    breakLine: b.lowLine,
    extreme: patternHigh,
    extremeLabel: "型態最高點",
    invalidation: patternHigh,
    startIndex: b.startIndex,
    breakFrom,
  });

  const geom =
    `上緣 ${round(at(b.highLine, lastIndex))}、下緣 ${round(at(b.lowLine, lastIndex))}，` +
    `區間由 ${round(b.startGap)} 收斂到 ${round(b.endGap)}（${Math.round(ratio * 100)}%），共 ${span} 根`;

  // 矩形 — both boundaries flat. Direction is undecided by the shape itself,
  // so it takes the prior trend; with no pole there is no basis to guess and
  // the pattern is reported without a directional claim by using the break
  // that actually happened (see the caller, which keeps both readings).
  if (highFlat && lowFlat) {
    const dir = pole ?? "long";
    return {
      ...(dir === "long" ? upper() : lower()),
      name: "矩形",
      kind: pole ? "continuation" : "either",
      note: `上下緣都接近水平（${geom}）。方向取${pole ? "前波趨勢" : "預設"}，實際以突破哪一邊為準。`,
    };
  }

  // 上升三角形 — flat top, rising lows. Buyers paying up into a fixed supply.
  if (highFlat && lowUp && converging) {
    return {
      ...upper(),
      name: "上升三角形",
      kind: "continuation",
      note: `上緣水平、下緣上升（${geom}）。`,
    };
  }

  // 下降三角形 — flat floor, falling highs.
  if (lowFlat && !highUp && converging) {
    return {
      ...lower(),
      name: "下降三角形",
      kind: "continuation",
      note: `下緣水平、上緣下降（${geom}）。`,
    };
  }

  if (converging && !highUp && lowUp) {
    // Symmetrical: the shape says nothing about direction, the pole does. With
    // a pole and a short span it is a pennant, which is the same geometry with
    // a stronger prior.
    const dir = pole ?? "long";
    const isPennant = pole !== null && span <= MAX_FLAG_SPAN;
    return {
      ...(dir === "long" ? upper() : lower()),
      name: isPennant ? "尖旗形" : "對稱三角形",
      kind: "continuation",
      note: isPennant
        ? `旗桿後的小型收斂（${geom}），方向續前波${pole === "long" ? "多" : "空"}。`
        : `上下緣同時收斂（${geom}）。方向由前波趨勢決定${pole ? "" : "——無明顯旗桿，方向較弱"}。`,
    };
  }

  // Wedges: both boundaries slope the same way and converge. The break is
  // against the slope, which is what makes a rising wedge bearish.
  if (converging && highUp && lowUp) {
    return { ...lower(), name: "上升楔形", kind: "reversal", note: `上升楔形，上下緣同時上升但收斂（${geom}），破下緣為賣訊。` };
  }
  if (converging && !highUp && !lowUp) {
    return { ...upper(), name: "下降楔形", kind: "reversal", note: `下降楔形，上下緣同時下降但收斂（${geom}），站上上緣為買訊。` };
  }

  if (diverging) {
    // Broadening: volatility expanding, both sides being run. Treated as a
    // reversal shape, direction taken from the break rather than the slope.
    const dir = highUp ? "short" : "long";
    return {
      ...(dir === "long" ? upper() : lower()),
      name: "擴散三角形",
      kind: "reversal",
      note: `區間持續放大（${geom}），波動擴張、兩邊都在被掃，方向以實際突破為準。`,
    };
  }

  // Parallel and sloping — a channel, or a flag when it is short and leans
  // against a pole.
  if (!highFlat && !lowFlat && highUp === lowUp) {
    const counter = pole !== null && (pole === "long") !== highUp;
    if (counter && span <= MAX_FLAG_SPAN) {
      return {
        ...(pole === "long" ? upper() : lower()),
        name: "旗形",
        kind: "continuation",
        note: `旗桿後的逆向平行整理（${geom}），方向續前波${pole === "long" ? "多" : "空"}。`,
      };
    }
    return {
      ...(highUp ? upper() : lower()),
      name: "通道",
      kind: "continuation",
      note: `上下緣接近平行且同向（${geom}）。`,
    };
  }

  return null;
}

/**
 * V 頂／V 底.
 *
 * These were left out at first on the reasoning that a V has no consolidation
 * and therefore nothing to retest. That was wrong, and the owner said so: a V
 * does have a neckline. It is the swing that preceded the final leg — the base
 * the spike launched from on a V top, the shelf it dropped from on a V bottom.
 * Price coming back through that level is exactly the confirmation the other
 * patterns get from their necklines, and it can be retested like any other.
 *
 * What makes it a V rather than a rounded top or the left half of a
 * head-and-shoulders is that both legs are steep and there is nothing between
 * them: one clean move up, one apex bar, one clean move back. So the tests are
 * about the *absence* of structure — no intervening pivots on either leg —
 * as much as about the size of the move.
 */
function detectV(pivots: Pivot[], candles: Candle[], atr: number, top: boolean): Built | null {
  const lastIndex = candles.length - 1;
  const apexType = top ? "high" : "low";
  // The apex is the most recent turn of the right kind that still has room for
  // a return leg after it.
  const apex = [...pivots].reverse().find((p) => p.type === apexType);
  if (!apex) return null;

  if (atr <= 0) return null;

  // The neckline: where the final leg started. Found by walking back from the
  // apex for as long as the bars keep making progress in the leg's direction,
  // rather than by looking for a pivot — a spike out of a quiet range launches
  // from the middle of that range, where there is no pivot to find. The walk
  // stops the moment progress stops, which is what makes the leg *one* leg:
  // a rally with a pullback in it ends the walk at the pullback and comes out
  // too short to qualify, which is correct. A V has no pullback.
  const flatEps = atr * 0.05;
  let baseIndex = apex.index;
  let basePrice = apex.price;
  for (let i = apex.index - 1; i >= 0; i--) {
    const v = top ? candles[i].low : candles[i].high;
    const progressed = top ? v < basePrice - flatEps : v > basePrice + flatEps;
    if (!progressed) break;
    basePrice = v;
    baseIndex = i;
  }
  const base = { index: baseIndex, price: basePrice };

  const legBars = apex.index - base.index;
  const legSize = Math.abs(apex.price - base.price);
  if (legBars < 2 || legBars > V_MAX_LEG_BARS) return null;
  if (legSize / atr < V_LEG_ATR) return null;

  // Nothing between the base and the apex: an intervening turn means the market
  // built structure on the way up, which is some other pattern.
  if (pivots.some((p) => p.index > base.index && p.index < apex.index)) return null;

  // And a return leg that has actually given back most of it, with nothing
  // between the apex and now either — a pivot after the apex means the market
  // built structure on the way down, which is a different pattern.
  if (pivots.some((p) => p.index > apex.index)) return null;
  const returnBars = lastIndex - apex.index;
  if (returnBars < 2 || returnBars > legBars * V_SYMMETRY) return null;

  const extremeSince = top
    ? Math.min(...candles.slice(apex.index).map((c) => c.low))
    : Math.max(...candles.slice(apex.index).map((c) => c.high));
  const givenBack = Math.abs(apex.price - extremeSince) / legSize;
  if (givenBack < V_RETRACE) return null;

  return {
    name: top ? "V頂" : "V底",
    kind: "reversal",
    direction: top ? "short" : "long",
    // Horizontal at the base: a V's neckline is a level, not a sloping line —
    // there is only one swing on each side to draw it through.
    breakLine: { slope: 0, intercept: base.price },
    extreme: apex.price,
    extremeLabel: top ? "V 頂尖端" : "V 底尖端",
    invalidation: apex.price,
    startIndex: base.index,
    breakFrom: apex.index,
    note:
      `${legBars} 根走完 ${round(legSize)}（${(legSize / atr).toFixed(1)}×ATR）的單邊急拉` +
      `${top ? "後急殺" : "後急拉"}，中間沒有任何轉折結構。` +
      `頸線取尖端前的${top ? "起漲低點" : "起跌高點"} ${round(base.price)}，` +
      `已回吐 ${Math.round(givenBack * 100)}%。`,
  };
}

/**
 * 菱形 — broadening then converging.
 *
 * Detected as two halves rather than one fit, because a diamond's boundaries
 * change direction halfway and any single line through them describes neither
 * half. Rare, and per the source material almost only at tops.
 */
function detectDiamond(pivots: Pivot[], candles: Candle[]): Built | null {
  if (pivots.length < 6) return null;
  const lastIndex = candles.length - 1;
  const recent = pivots.slice(-8);
  const half = Math.floor(recent.length / 2);
  const first = boundaries(recent.slice(0, half + 1), recent[half].index);
  const second = boundaries(recent.slice(half), lastIndex);
  if (!first || !second) return null;
  if (!(first.endGap / first.startGap > DIVERGE_RATIO)) return null;
  if (!(second.endGap / second.startGap < CONVERGE_RATIO)) return null;

  const patternHigh = Math.max(...recent.filter((p) => p.type === "high").map((p) => p.price));
  const patternLow = Math.min(...recent.filter((p) => p.type === "low").map((p) => p.price));
  const dir: "long" | "short" = candles[lastIndex].close > (patternHigh + patternLow) / 2 ? "short" : "long";
  return {
    name: "菱形",
    kind: "reversal",
    direction: dir,
    breakLine: dir === "short" ? second.lowLine : second.highLine,
    extreme: dir === "short" ? patternHigh : patternLow,
    extremeLabel: dir === "short" ? "型態最高點" : "型態最低點",
    invalidation: dir === "short" ? patternHigh : patternLow,
    startIndex: recent[0].index,
    breakFrom: recent.at(-1)!.index,
    note: `前半擴張、後半收斂的菱形（${round(patternLow)}–${round(patternHigh)}）。依原始資料，菱形反轉幾乎只出現在頭部。`,
  };
}

/**
 * 圓頂／圓底 — a parabola through the closes.
 *
 * Included where V tops are not, because a rounding pattern does have a
 * neckline: the level the two ends sit at. Strict on purpose — the fit has to
 * explain most of the variance and the vertex has to be in the middle third —
 * since a loose quadratic fits almost any wobble.
 */
function detectRounding(candles: Candle[], atr: number): Built | null {
  const n = candles.length;
  const window = Math.min(60, n);
  if (window < 24) return null;
  const start = n - window;
  const xs = Array.from({ length: window }, (_, i) => i);
  const ys = candles.slice(start).map((c) => c.close);

  // Quadratic least squares via the normal equations on a centred x.
  const mid = (window - 1) / 2;
  const cx = xs.map((x) => x - mid);
  const s0 = window;
  const s2 = cx.reduce((s, x) => s + x * x, 0);
  const s4 = cx.reduce((s, x) => s + x ** 4, 0);
  const t0 = ys.reduce((s, y) => s + y, 0);
  const t1 = cx.reduce((s, x, i) => s + x * ys[i], 0);
  const t2 = cx.reduce((s, x, i) => s + x * x * ys[i], 0);
  const denom = s0 * s4 - s2 * s2;
  if (denom === 0) return null;
  const a = (s0 * t2 - s2 * t0) / denom;
  const b = t1 / s2;
  const c = (s4 * t0 - s2 * t2) / denom;
  const predict = (x: number) => a * x * x + b * x + c;

  const mean = t0 / window;
  const ssTot = ys.reduce((s, y) => s + (y - mean) ** 2, 0);
  const ssRes = ys.reduce((s, y, i) => s + (y - predict(cx[i])) ** 2, 0);
  if (ssTot === 0) return null;
  const r2 = 1 - ssRes / ssTot;
  if (r2 < 0.7) return null;
  if (a === 0) return null;

  const vertexX = -b / (2 * a);
  if (Math.abs(vertexX) > window / 6) return null; // vertex must sit mid-window
  const top = a < 0; // opens downward → a dome
  const neckline = (predict(cx[0]) + predict(cx[window - 1])) / 2;
  const vertex = predict(vertexX);
  if (Math.abs(vertex - neckline) < atr) return null; // too shallow to be a shape

  return {
    name: top ? "圓頂" : "圓底",
    kind: "reversal",
    direction: top ? "short" : "long",
    breakLine: { slope: 0, intercept: neckline },
    extreme: vertex,
    extremeLabel: top ? "圓頂最高點" : "圓底最低點",
    invalidation: vertex,
    startIndex: start,
    // Only the far side of the curve can break the neckline; the near side sits
    // on it by construction.
    breakFrom: start + Math.round(window * 0.75),
    note: `${window} 根的二次擬合 R²=${r2.toFixed(2)}，${top ? "頂" : "底"}部 ${round(vertex)}，頸線取兩端平均 ${round(neckline)}。`,
  };
}

// ── entry point ───────────────────────────────────────────────────

export interface PatternResult {
  patterns: ChartPattern[];
  gaps: string[];
}

/**
 * Every pattern currently on the chart for one timeframe, newest shapes only.
 *
 * Returns them all — forming, broken out, confirmed and failed — because the
 * card's job is to show what the market is doing, and "頭肩頂已突破但還沒回踩"
 * is exactly the state a trader needs to see. The *trade* is gated elsewhere,
 * on `status === "confirmed"`, so showing an unconfirmed pattern costs nothing
 * and hiding it would cost the reason.
 */
export function detectPatterns(candles: Candle[], timeframe: Timeframe): PatternResult {
  const gaps: string[] = [];
  if (candles.length < MIN_SPAN_BARS * 3) {
    return { patterns: [], gaps: [`${timeframe} K棒不足 ${MIN_SPAN_BARS * 3} 根，無法辨識圖形型態`] };
  }
  const atr = computeAtr(candles, 14);
  if (!atr || atr <= 0) {
    return { patterns: [], gaps: [`${timeframe} 無法計算 ATR，圖形型態的容差沒有基準，略過辨識`] };
  }

  const windowed = candles.slice(Math.max(0, candles.length - WINDOW_BARS));
  const pivots = cleanPivots(windowed, atr);

  // No blanket "need N pivots" gate here. A V needs exactly one — its apex —
  // and an early return on a pivot count would have made the pattern with the
  // fewest turning points the one pattern that could never be found. Each
  // detector states its own requirement; the shortfall is only worth reporting
  // if nothing was found at all.
  if (pivots.length === 0) {
    return { patterns: [], gaps: [`${timeframe} 近 ${windowed.length} 根找不到任何擺盪轉折點，無法辨識圖形型態`] };
  }

  const built: Built[] = [
    ...detectPeakPatterns(pivots, windowed, atr, true),
    ...detectPeakPatterns(pivots, windowed, atr, false),
  ];
  const boundary = detectBoundaryPattern(pivots, windowed, atr);
  if (boundary) built.push(boundary);
  for (const top of [true, false]) {
    const v = detectV(pivots, windowed, atr, top);
    if (v) built.push(v);
  }
  const diamond = detectDiamond(pivots, windowed);
  if (diamond) built.push(diamond);
  const rounding = detectRounding(windowed, atr);
  if (rounding) built.push(rounding);

  const patterns = built.map((b) => finalise(b, windowed, timeframe, atr));

  // Newest first, and a confirmed pattern outranks a forming one of the same age.
  const rank: Record<ChartPattern["status"], number> = {
    confirmed: 0,
    broken_out: 1,
    forming: 2,
    failed: 3,
  };
  patterns.sort((a, b) => rank[a.status] - rank[b.status] || b.strength - a.strength);

  if (patterns.length === 0 && pivots.length < 4) {
    gaps.push(
      `${timeframe} 近 ${windowed.length} 根只找到 ${pivots.length} 個擺盪轉折點，不足以構成型態`,
    );
  }

  return { patterns, gaps };
}

/** Runs the detector over every timeframe that has candles, and merges. */
export function detectAllPatterns(
  candlesByTf: Partial<Record<Timeframe, Candle[]>>,
  gaps: string[],
): ChartPattern[] {
  const all: ChartPattern[] = [];
  // W1 excluded: 120 weekly bars is over two years, and a head-and-shoulders
  // spanning two years is not a thing you trade off a 4-hourly refresh.
  for (const tf of ["D1", "H4"] as const) {
    const candles = candlesByTf[tf];
    if (!candles || candles.length === 0) continue;
    const result = detectPatterns(candles, tf);
    all.push(...result.patterns);
    gaps.push(...result.gaps);
  }
  return all;
}

export interface PatternContributions {
  biasItems: BiasItem[];
  entryStructures: EntryStructure[];
  pathObstacles: PathObstacle[];
}

/**
 * What the detected patterns are allowed to change about the signal.
 *
 * The gate is `status === "confirmed"`, and it is the whole feature. Only a
 * pattern that broke, carried participation and held its retest may:
 *
 *  - **vote on direction** with a real weight,
 *  - **become a protecting structure** at its neckline, which is what makes it
 *    eligible to anchor the stop (`buildStopLoss` filters on the same list),
 *  - **place a target** as a path obstacle, which is how 止盈看頭／看三角形最高點
 *    reaches the card.
 *
 * Everything else is reported at weight 0 — visible on the card, worth nothing
 * to the score. That is the difference between "a head-and-shoulders is
 * forming" and "a head-and-shoulders has been confirmed", and collapsing the
 * two is how pattern trading earns its reputation.
 */
export function patternContributions(
  patterns: ChartPattern[],
  currentPrice: number,
): PatternContributions {
  const biasItems: BiasItem[] = [];
  const entryStructures: EntryStructure[] = [];
  const pathObstacles: PathObstacle[] = [];

  for (const p of patterns) {
    const pending = p.checks.filter((c) => !c.passed).map((c) => c.label);
    const statusLabel =
      p.status === "confirmed"
        ? "已確認"
        : p.status === "broken_out"
          ? `已突破，待${pending.join("、")}`
          : p.status === "failed"
            ? "假突破"
            : "形成中";

    biasItems.push({
      dimension: "技術面",
      factor: `${p.timeframe} ${p.name}（${statusLabel}）`,
      // A failed pattern points the other way — a break that got rejected is
      // evidence for the side that rejected it — but it is not given weight,
      // because "the opposite of a failed signal" is not itself a signal.
      direction: p.status === "confirmed" ? p.direction : "neutral",
      weight: p.status === "confirmed" ? (p.strength >= 2 ? 2 : 1) : 0,
      evidence:
        `頸線／邊界 ${p.breakout_level}、目標 ${p.target}、失效 ${p.invalidation_level}；` +
        p.checks.map((c) => `${c.passed ? "✓" : "✗"} ${c.label}`).join("；"),
      source: `${p.timeframe} K棒 ${p.from.slice(0, 10)}～${p.to.slice(0, 10)}（${p.bars} 根）`,
    });

    if (p.status !== "confirmed") continue;

    // The neckline, now retested and holding. Role follows the break: a broken
    // resistance that held on the retest is support.
    entryStructures.push({
      price: p.breakout_level,
      type: "型態頸線",
      role: p.direction === "long" ? "support" : "resistance",
      timeframe: p.timeframe,
      strength: p.strength,
      distance_pct:
        currentPrice > 0
          ? Math.round(((p.breakout_level - currentPrice) / currentPrice) * 10000) / 100
          : 0,
    });

    pathObstacles.push({
      price: p.target,
      type: `${p.name}目標`,
      timeframe: p.timeframe,
      strength: p.strength,
    });
  }

  return { biasItems, entryStructures, pathObstacles };
}

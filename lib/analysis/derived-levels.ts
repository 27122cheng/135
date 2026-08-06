import type { Timeframe } from "@/types/signal";
import type { Candle } from "../data-sources/ohlcv";
import type { PriceLevel } from "./levels";

/**
 * Levels the market respects that swing clustering cannot see.
 *
 * Swing clusters are the strongest evidence available — price actually turned
 * there, repeatedly — but they are also the *only* evidence the analysis had,
 * and that turned out to be the binding constraint. A signal with no cluster
 * within 1.5% of price gets no stop and is force-graded no-trade; US30 scored
 * 14 out of a possible 14 and was still rejected because nothing in that narrow
 * band happened to be a swing.
 *
 * The three sources here fill the gaps between swings. All are pure functions
 * over candles already fetched — no new API, no key, no AI call.
 *
 * They are deliberately weaker than a real cluster. A round number is where
 * orders *tend* to sit; a triple-touched swing high is where they demonstrably
 * did. Strength 1 keeps them as tie-breakers and stop anchors rather than
 * things that can carry a grade on their own.
 */

/** Everything here is context, never confirmed structure. */
const DERIVED_STRENGTH = 1 as const;

function level(
  price: number,
  kind: PriceLevel["kind"],
  timeframes: Timeframe[],
): PriceLevel {
  return { price, touches: 1, timeframes, kind, strength: DERIVED_STRENGTH };
}

/**
 * The increment that counts as "round" for this instrument.
 *
 * Derived from the price itself rather than a per-symbol table, so a new
 * instrument needs no configuration and cannot be forgotten: gold near 2000
 * gets 10s, EUR/USD near 1.08 gets 0.0050, an index near 40000 gets 500.
 */
export function roundStep(price: number): number {
  if (!(price > 0)) return 0;
  const magnitude = Math.pow(10, Math.floor(Math.log10(price)));
  // A hundredth of the magnitude, then halved — 0.005 on a 1.xx pair, 5 on a
  // 2000 instrument, 500 on a 40000 one. Close to what traders actually watch.
  return magnitude / 200;
}

/**
 * 整數關卡 — the round numbers straddling the current price.
 *
 * Real on every instrument here and strongest on FX and metals, where resting
 * orders bunch at figures and half-figures. Cheap, deterministic, and it puts
 * a candidate level within reach of price at all times, which is precisely
 * what the "no structure within 1.5%" refusal was missing.
 */
export function roundNumberLevels(price: number, count = 3): PriceLevel[] {
  const step = roundStep(price);
  if (!(step > 0)) return [];
  const base = Math.round(price / step) * step;
  const out: PriceLevel[] = [];
  for (let i = -count; i <= count; i++) {
    const p = base + i * step;
    if (p <= 0 || Math.abs(p - price) < step / 4) continue;
    // Above price behaves as resistance, below as support — the same
    // convention clusterSwings uses for highs and lows.
    out.push(level(round(p, step), p > price ? "high" : "low", ["D1"]));
  }
  return out;
}

/**
 * 前一根 D1／W1 的高低點.
 *
 * The most watched levels in intraday trading after the round numbers, and the
 * ones brokers' own stop clusters sit around. Uses the *completed* prior bar,
 * never the one still forming — a high that can still change is not a level.
 */
export function priorPeriodLevels(
  candlesByTf: Partial<Record<Timeframe, Candle[]>>,
): PriceLevel[] {
  const out: PriceLevel[] = [];
  for (const tf of ["D1", "W1"] as const) {
    const candles = candlesByTf[tf];
    // -2, not -1: the last element is the bar in progress.
    const prior = candles?.at(-2);
    if (!prior) continue;
    out.push(level(prior.high, "high", [tf]));
    out.push(level(prior.low, "low", [tf]));
  }
  return out;
}

/**
 * 斐波那契回撤 — 38.2% / 50% / 61.8% of the most recent significant swing.
 *
 * Included for one reason: these are the levels that sit *between* swing
 * clusters. Every other source here marks a place price has already been;
 * retracements mark where a move is likely to pause on its way back, which is
 * exactly the region a pullback entry needs and where the swing set is empty
 * by construction.
 *
 * Taken from the highest high and lowest low of the recent window rather than
 * a hand-picked leg, so there is no discretion in which swing gets measured.
 */
export function fibRetracementLevels(candles: Candle[] | undefined, lookback = 60): PriceLevel[] {
  if (!candles || candles.length < 10) return [];
  const window = candles.slice(-lookback);
  let high = -Infinity;
  let low = Infinity;
  for (const c of window) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }
  const range = high - low;
  if (!(range > 0)) return [];
  // A range smaller than a tenth of a percent is noise, not a swing to measure.
  if (range / high < 0.001) return [];

  return [0.382, 0.5, 0.618].map((r) => {
    const price = high - range * r;
    // Retracements of an up-move act as support, and vice versa; using the
    // midpoint as the pivot keeps this decided by the data, not by a guess
    // about which direction the leg ran.
    return level(price, price > (high + low) / 2 ? "high" : "low", ["D1"]);
  });
}

function round(value: number, step: number): number {
  // Round to the step's own precision so 1.0850000000000002 doesn't reach the UI.
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)) + 1);
  return Number(value.toFixed(Math.min(8, decimals)));
}

/**
 * Merges derived levels into the swing clusters, dropping any that duplicate
 * a level already found.
 *
 * A real cluster always wins a collision: it is the same price backed by
 * stronger evidence, and admitting both would double-count one level in the
 * structure score.
 */
export function mergeDerived(
  clusters: PriceLevel[],
  derived: PriceLevel[],
  tolerance: number,
): PriceLevel[] {
  const kept = derived.filter(
    (d) => !clusters.some((c) => Math.abs(c.price - d.price) <= tolerance),
  );
  // Also dedupe the derived set against itself — a round number and a prior
  // day's high can easily land on the same price.
  const unique: PriceLevel[] = [];
  for (const d of kept) {
    if (unique.some((u) => Math.abs(u.price - d.price) <= tolerance)) continue;
    unique.push(d);
  }
  return [...clusters, ...unique];
}

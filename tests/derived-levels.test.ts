import { check, report } from "./_harness";
import {
  fibRetracementLevels,
  mergeDerived,
  priorPeriodLevels,
  roundNumberLevels,
  roundStep,
} from "@/lib/analysis/derived-levels";
import type { PriceLevel } from "@/lib/analysis/levels";
import type { Candle } from "@/lib/data-sources/ohlcv";

/**
 * Derived levels exist to stop "no swing cluster near price" from being the
 * thing that decides whether a signal can trade. The rules that must not
 * drift: they are always weaker than a real cluster, they never duplicate one,
 * and they scale to the instrument without a per-symbol table.
 */

function candle(high: number, low: number, i: number): Candle {
  return {
    time: `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    open: (high + low) / 2,
    high,
    low,
    close: (high + low) / 2,
    volume: 100,
  };
}

// ── the step scales with the instrument ───────────────────────────
{
  // No per-symbol table: a new instrument must work with no configuration.
  check("a 1.xx FX pair steps in half-pips-of-a-figure", roundStep(1.085) === 0.005);
  check("gold near 2000 steps in 5s", roundStep(2000) === 5);
  check("an index near 40000 steps in 50s", roundStep(40000) === 50);
  check("a zero price has no step", roundStep(0) === 0);
  check("a negative price has no step", roundStep(-5) === 0);
}

// ── round numbers ─────────────────────────────────────────────────
{
  const levels = roundNumberLevels(2003, 2);
  check("levels are produced", levels.length > 0, levels.length);
  check("every level is weak", levels.every((l) => l.strength === 1));
  // Above price is resistance, below is support — the same convention the
  // swing clusters use, or the two sets would contradict each other.
  check("levels above price are highs",
    levels.filter((l) => l.price > 2003).every((l) => l.kind === "high"));
  check("levels below price are lows",
    levels.filter((l) => l.price < 2003).every((l) => l.kind === "low"));
  check("they straddle the price",
    levels.some((l) => l.price > 2003) && levels.some((l) => l.price < 2003));

  // A level essentially at the current price is not a level to trade against.
  const atFigure = roundNumberLevels(2000, 2);
  check("the price's own figure is skipped",
    !atFigure.some((l) => Math.abs(l.price - 2000) < 1), atFigure.map((l) => l.price));

  // Float noise must not reach the display.
  const fx = roundNumberLevels(1.0851, 2);
  check("FX prices round cleanly",
    fx.every((l) => String(l.price).replace(/^\\d+\\./, "").length <= 8),
    fx.map((l) => l.price));
}

// ── prior period high/low ─────────────────────────────────────────
{
  const d1 = [candle(110, 90, 0), candle(120, 100, 1), candle(130, 95, 2)];
  const levels = priorPeriodLevels({ D1: d1 });
  // The last candle is still forming; a high that can still change is not a
  // level. This must read the completed bar before it.
  check("the still-forming bar is ignored",
    !levels.some((l) => l.price === 130 || l.price === 95), levels.map((l) => l.price));
  check("the prior bar's high is used", levels.some((l) => l.price === 120 && l.kind === "high"));
  check("and its low", levels.some((l) => l.price === 100 && l.kind === "low"));
  check("it is tagged with the timeframe it came from",
    levels.every((l) => l.timeframes.includes("D1")));

  check("one candle is not enough", priorPeriodLevels({ D1: [candle(1, 1, 0)] }).length === 0);
  check("no candles is not an error", priorPeriodLevels({}).length === 0);

  const both = priorPeriodLevels({ D1: d1, W1: d1 });
  check("D1 and W1 both contribute", both.length === 4, both.length);
}

// ── fibonacci retracements ────────────────────────────────────────
{
  // Range 100 → 200 over the window.
  const candles = Array.from({ length: 20 }, (_, i) =>
    candle(i === 5 ? 200 : 150, i === 10 ? 100 : 120, i),
  );
  const fibs = fibRetracementLevels(candles);
  check("three retracements", fibs.length === 3, fibs.length);
  check("61.8% of a 100-point range sits at 138.2",
    fibs.some((f) => Math.abs(f.price - 138.2) < 0.01), fibs.map((f) => f.price));
  check("50% sits at the midpoint", fibs.some((f) => Math.abs(f.price - 150) < 0.01));
  check("all are weak", fibs.every((f) => f.strength === 1));
  check("all sit inside the range",
    fibs.every((f) => f.price > 100 && f.price < 200), fibs.map((f) => f.price));

  check("too few candles yields nothing", fibRetracementLevels([candle(1, 1, 0)]).length === 0);
  check("no candles yields nothing", fibRetracementLevels(undefined).length === 0);
  // A flat window has no swing worth measuring; inventing three levels across
  // a 0.01% range would be fabricating structure out of noise.
  const flat = Array.from({ length: 20 }, (_, i) => candle(100.01, 100, i));
  check("a flat range is refused", flat.length > 0 && fibRetracementLevels(flat).length === 0);
}

// ── merging ───────────────────────────────────────────────────────
{
  const cluster: PriceLevel = {
    price: 2000,
    touches: 3,
    timeframes: ["D1", "W1"],
    kind: "low",
    strength: 3,
  };
  const derived: PriceLevel[] = [
    { price: 2001, touches: 1, timeframes: ["D1"], kind: "low", strength: 1 },
    { price: 2100, touches: 1, timeframes: ["D1"], kind: "high", strength: 1 },
  ];

  const merged = mergeDerived([cluster], derived, 5);
  // The real cluster wins a collision: same price, stronger evidence. Keeping
  // both would double-count one level in the structure score.
  check("a derived level colliding with a cluster is dropped", merged.length === 2, merged.length);
  check("the surviving cluster keeps its strength",
    merged.find((l) => l.price === 2000)?.strength === 3);
  check("the non-colliding derived level survives", merged.some((l) => l.price === 2100));

  // Two derived sources landing on the same price (a round number and a prior
  // day's high, say) must not both be admitted.
  const twins: PriceLevel[] = [
    { price: 2100, touches: 1, timeframes: ["D1"], kind: "high", strength: 1 },
    { price: 2102, touches: 1, timeframes: ["W1"], kind: "high", strength: 1 },
  ];
  check("derived levels are deduped against each other",
    mergeDerived([], twins, 5).length === 1, mergeDerived([], twins, 5));

  check("no derived levels changes nothing", mergeDerived([cluster], [], 5).length === 1);
  check("no clusters keeps every derived level", mergeDerived([], derived, 5).length === 2);
}

report("derived levels");

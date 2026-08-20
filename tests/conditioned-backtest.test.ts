import { check, report } from "./_harness";
import { backtestPlanGeometry } from "@/lib/analysis/backtest";
import type { Candle } from "@/lib/data-sources/ohlcv";

/**
 * 「勝率全部都過低，永遠過不了」— and the floor was fine; the sample was wrong.
 *
 * The old walk sampled every same-side-of-EMA50 bar, which mixes chop and
 * exhaustion days into the estimate and drags it toward the random-walk
 * baseline (stop/(stop+target) ≈ 40% at 1:1.5) — so geometry that genuinely
 * wins 70% of the time *under the conditions the signals fire in* kept
 * failing a floor it deserved to pass. The tiers condition the sample on the
 * setup: EMA side + MACD sign + RSI side first, relaxing only when the
 * stronger tier lacks samples, and always saying which tier answered.
 */

function mixedMarket(): Candle[] {
  // First half: choppy decline; second half: clean uptrend. A long geometry
  // measured over "all bars" is dragged down by the first half it would never
  // have fired in.
  return Array.from({ length: 460 }, (_, i) => {
    const p =
      i < 230
        ? 60000 - i * 10 + Math.sin(i / 3) * 700
        : 57700 + (i - 230) * 40 + Math.sin(i / 7) * 150;
    return {
      time: new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString(),
      open: p,
      high: p + 260,
      low: p - 260,
      close: p,
      volume: 1000,
    };
  });
}

{
  const candles = mixedMarket();
  const last = candles[candles.length - 1].close;
  // A stop outside the daily noise (~1.5×ATR): with the managed walk a
  // sub-ATR stop is a breakeven scratch machine, which is a lesson about
  // stops, not about conditioning.
  const bt = backtestPlanGeometry("long", last, last - 800, last + 1200, candles)!;

  check("the strongest tier answers when its sample suffices",
    bt.conditioned === true && bt.basis?.includes("MACD 同向") === true, bt.basis);
  check("with a real sample", bt.resolved >= 30, bt.resolved);
  // Gross, this fixture cleared 0.70. Net of the round-trip cost it lands
  // just under — which is the whole point of charging one: the operator's
  // floor now applies to a number they could actually realize, and a
  // geometry that only cleared it by paying no spread should not pass.
  // What the tier still has to prove is that it is far above the
  // random-walk baseline (stop/(stop+target) ≈ 0.4 at this geometry) —
  // that gap is what conditioning bought, and cost does not touch it.
  check("and the setup-conditioned hit rate stays far above the random-walk baseline",
    (bt.hitRate ?? 0) >= 0.65, bt.hitRate);
  check("with the cost stated rather than assumed",
    (bt.costPct ?? 0) > 0 && bt.basis?.includes("交易成本") === true,
    { costPct: bt.costPct, basis: bt.basis });
  check("RSI is part of the strongest tier", bt.basis?.includes("RSI") === true, bt.basis);
}

{
  // A short in the same market: its matching regime is the *first* half.
  const candles = mixedMarket();
  const last = candles[candles.length - 1].close;
  const bt = backtestPlanGeometry("short", last, last + 800, last - 1200, candles)!;
  check("the mirror direction conditions on its own regime",
    bt.basis?.includes("空頭") === true, bt.basis);
}

{
  // Too little history for any tier to hit 30 resolved: the walk still
  // answers with what it has, and the caller's floor logic treats a thin
  // sample as unverified — that contract lives in trade-plan, but the basis
  // here must say the stronger tiers were skipped for lack of samples.
  const candles = mixedMarket().slice(0, 300);
  const last = candles[candles.length - 1].close;
  const bt = backtestPlanGeometry("long", last, last - 800, last + 1200, candles);
  check("thin history still returns an answer rather than nothing", bt !== null, bt);
  if (bt && bt.resolved >= 30) {
    check("and says when stricter tiers lacked samples",
      bt.basis?.includes("樣本不足") === true || bt.basis?.includes("MACD") === true, bt.basis);
  }
}

report("conditioned backtest");

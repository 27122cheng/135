import type { Candle } from "../data-sources/ohlcv";

/**
 * Empirical check on a plan's stop/target geometry, computed locally from the
 * instrument's own historical candles — no AI, no extra API call.
 *
 * What it answers: "with a stop this far away and a target this far away, how
 * often has price historically reached the target before the stop?" It walks
 * every past bar, assumes an entry at that close in the signal's direction,
 * places the stop and target at the *same relative distances* as the current
 * plan, and steps forward until one is touched.
 *
 * What it does NOT answer: whether this particular signal is good. The walk is
 * unconditional — it samples every bar, not just bars matching the signal's
 * six-dimension state — so it measures the geometry against the instrument's
 * volatility, not the edge of the setup. Read it as a feasibility check on the
 * risk/reward, not as a win rate for the strategy.
 */

export interface PlanBacktest {
  /** Bars where the trade resolved (target or stop touched). */
  resolved: number;
  wins: number;
  losses: number;
  /** Neither level touched inside the horizon. */
  timeouts: number;
  /** wins / resolved, 0..1. Null when nothing resolved. */
  hitRate: number | null;
  /**
   * Expected value per unit of risk: hitRate × riskReward − (1 − hitRate).
   * Positive means the geometry has been historically worth taking.
   */
  expectancyR: number | null;
  horizonBars: number;
  lookbackBars: number;
  /** True when at least one sample touched both levels in the same bar. */
  hadAmbiguousBars: boolean;
}

export function backtestPlanGeometry(
  direction: "long" | "short",
  entry: number,
  stopLoss: number,
  takeProfit: number,
  candles: Candle[],
  riskReward: number,
  horizonBars = 20,
): PlanBacktest | null {
  if (entry <= 0 || candles.length < horizonBars + 20) return null;

  const slPct = Math.abs(entry - stopLoss) / entry;
  const tpPct = Math.abs(takeProfit - entry) / entry;
  if (!(slPct > 0) || !(tpPct > 0)) return null;

  let wins = 0;
  let losses = 0;
  let timeouts = 0;
  let hadAmbiguousBars = false;

  const lastStart = candles.length - horizonBars - 1;
  for (let i = 0; i <= lastStart; i++) {
    const e = candles[i].close;
    if (!(e > 0)) continue;
    const slLevel = direction === "long" ? e * (1 - slPct) : e * (1 + slPct);
    const tpLevel = direction === "long" ? e * (1 + tpPct) : e * (1 - tpPct);

    let settled = false;
    for (let j = i + 1; j <= i + horizonBars; j++) {
      const bar = candles[j];
      const hitSl = direction === "long" ? bar.low <= slLevel : bar.high >= slLevel;
      const hitTp = direction === "long" ? bar.high >= tpLevel : bar.low <= tpLevel;

      if (hitSl && hitTp) {
        // Daily bars don't record intrabar order, so we can't know which came
        // first. Count it as a loss — the pessimistic read — rather than
        // inflating the hit rate with a coin flip.
        hadAmbiguousBars = true;
        losses++;
        settled = true;
        break;
      }
      if (hitSl) {
        losses++;
        settled = true;
        break;
      }
      if (hitTp) {
        wins++;
        settled = true;
        break;
      }
    }
    if (!settled) timeouts++;
  }

  const resolved = wins + losses;
  const hitRate = resolved > 0 ? wins / resolved : null;
  const expectancyR =
    hitRate === null ? null : Math.round((hitRate * riskReward - (1 - hitRate)) * 100) / 100;

  return {
    resolved,
    wins,
    losses,
    timeouts,
    hitRate: hitRate === null ? null : Math.round(hitRate * 1000) / 1000,
    expectancyR,
    horizonBars,
    lookbackBars: lastStart + 1,
    hadAmbiguousBars,
  };
}

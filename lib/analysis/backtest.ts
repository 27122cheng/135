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
 * ## Conditioned on the regime
 *
 * The walk used to sample *every* bar, which measured the geometry against the
 * instrument's volatility over all conditions — including the half of history
 * pointing the other way. For a long plan that means most of the sample was
 * drawn from downtrends, and a hit rate computed that way is close to
 * meaningless as an answer to "will this target get hit from here".
 *
 * It now samples only bars in a regime matching the signal's direction: above
 * the 50-bar EMA for a long, below it for a short. That turns the question from
 * "how often does this instrument travel this far in 20 bars, ever" into "how
 * often does it travel this far when it is trending the way we think it is" —
 * which is the question the number is actually being read as.
 *
 * The filter is deliberately crude. A finer regime definition (volatility
 * buckets, the signal's own six-dimension state) would shrink the sample below
 * the point where a hit rate means anything, and this already selects the plan's
 * geometry, so a noisy estimate here does real damage. When the conditioned
 * sample is too small the walk falls back to unconditional and `basis` says so.
 *
 * ## What it still does NOT answer
 *
 * Whether this particular signal is good. It is not conditioned on the setup —
 * only on the trend — so read it as a feasibility check on the risk/reward
 * under the current regime, not as a win rate for the strategy.
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
  /** Whether the sample was restricted to bars trending the signal's way. */
  conditioned?: boolean;
  /** How the sample was drawn, in words. Shown wherever the numbers are. */
  basis?: string;
}

/**
 * Below this many resolved samples a conditioned walk is dropped in favour of
 * the unconditional one: a precise answer about the right question beats
 * nothing, but a noisy answer about the right question does not beat a solid
 * answer about a broader one — especially now that this number *chooses* the
 * plan's geometry.
 */
const MIN_CONDITIONED_RESOLVED = 30;

/** 50-bar EMA of closes, aligned to the candle array. */
function trendLine(candles: Candle[], period = 50): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [candles[0]?.close ?? 0];
  for (let i = 1; i < candles.length; i++) {
    out.push(candles[i].close * k + out[i - 1] * (1 - k));
  }
  return out;
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
  const conditioned = walk(direction, entry, stopLoss, takeProfit, candles, riskReward, horizonBars, true);
  if (conditioned && conditioned.resolved >= MIN_CONDITIONED_RESOLVED) return conditioned;
  const all = walk(direction, entry, stopLoss, takeProfit, candles, riskReward, horizonBars, false);
  if (!all) return conditioned;
  return {
    ...all,
    basis:
      conditioned === null
        ? all.basis
        : `僅取${direction === "long" ? "多頭" : "空頭"}格局的樣本只有 ${conditioned.resolved} 筆，` +
          `不足 ${MIN_CONDITIONED_RESOLVED} 筆，改用全部 ${all.resolved} 筆（含反向格局，估計偏保守）`,
  };
}

function walk(
  direction: "long" | "short",
  entry: number,
  stopLoss: number,
  takeProfit: number,
  candles: Candle[],
  riskReward: number,
  horizonBars: number,
  conditioned: boolean,
): PlanBacktest | null {
  if (entry <= 0 || candles.length < horizonBars + 20) return null;

  const slPct = Math.abs(entry - stopLoss) / entry;
  const tpPct = Math.abs(takeProfit - entry) / entry;
  if (!(slPct > 0) || !(tpPct > 0)) return null;

  let wins = 0;
  let losses = 0;
  let timeouts = 0;
  let hadAmbiguousBars = false;
  let sampled = 0;

  const ema = conditioned ? trendLine(candles) : null;
  const lastStart = candles.length - horizonBars - 1;
  for (let i = 0; i <= lastStart; i++) {
    const e = candles[i].close;
    if (!(e > 0)) continue;
    if (ema) {
      // Only bars whose trend agrees with the plan. The first `period` bars of
      // an EMA are still converging from the seed, so they are skipped rather
      // than classified on a number that is mostly the first close.
      if (i < 50) continue;
      const trending = direction === "long" ? e > ema[i] : e < ema[i];
      if (!trending) continue;
    }
    sampled++;
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
    lookbackBars: sampled,
    hadAmbiguousBars,
    conditioned,
    basis: conditioned
      ? `只取價格在 EMA50 ${direction === "long" ? "之上" : "之下"}的 ${sampled} 根 K 棒為進場點，` +
        `即與訊號同向的格局`
      : `取全部 ${sampled} 根 K 棒為進場點，不分格局`,
  };
}

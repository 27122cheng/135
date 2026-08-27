import type { Candle } from "../data-sources/ohlcv";
import { COMMODITIES } from "@/types/signal";
import { totalCostFraction, tradingCostFor } from "@/config/trading-costs";
import { ema, macd, rsi } from "./indicators";
import { buildContext, type LabContext } from "./lab-conditions";
import { walkManaged } from "./lab-manage";

/**
 * Empirical check on a plan's stop/target geometry, computed locally from the
 * instrument's own historical candles — no AI, no extra API call.
 *
 * What it answers: "with a stop this far away and a target this far away,
 * managed the way this system actually manages a position, what has this
 * trade historically returned?" It walks every past bar, assumes an entry at
 * that close in the signal's direction, places the stop and target at the
 * *same relative distances* as the current plan, and then runs the shared
 * exit engine (lib/analysis/lab-manage.ts): breakeven at 1R, the stop
 * trailed behind newly confirmed swings, exit on an opposite CHoCH, closed
 * at the market at the horizon. The monitor applies those same rules to the
 * live position, so the measured number describes the trade that will
 * actually be taken — a static walk was measuring a trade nobody runs, and
 * failing plans the management would have scratched at breakeven instead of
 * losing.
 *
 * ## Conditioned on the regime
 *
 * The walk used to sample *every* bar, which measured the geometry against the
 * instrument's volatility over all conditions — including the half of history
 * pointing the other way. For a long plan that means most of the sample was
 * drawn from downtrends, and a hit rate computed that way is close to
 * meaningless as an answer to "will this target get hit from here".
 *
 * It now samples in **tiers of setup similarity**, strongest first, and uses
 * the strongest tier that still yields a real sample:
 *
 *  - T1: EMA50 side + MACD histogram sign + RSI side all agreeing with the
 *    signal's direction — bars that looked like *this* setup;
 *  - T2: EMA50 side + MACD sign;
 *  - T3: EMA50 side (the old conditioning);
 *  - T4: every bar (the old fallback).
 *
 * The tiering exists because the single-condition sample answered the wrong
 * question at the operator's 70% floor. The signals only fire when the
 * technical state agrees; sampling every same-side-of-EMA bar mixes in the
 * chop and the exhaustion days, drags the measured hit rate toward the
 * random-walk baseline (stop/(stop+target) ≈ 40% at 1:1.5), and fails
 * geometry that genuinely wins 70% of the time *under the conditions the
 * signal actually fires in*. Conditioning on more of the setup measures
 * P(win | setup), which is the number the floor is comparing against.
 *
 * Each tier still needs {@link MIN_CONDITIONED_RESOLVED} resolved samples —
 * a precise answer about the right question beats nothing, but a noisy answer
 * does not beat a solid broader one — and `basis` always says which tier
 * produced the number.
 *
 * ## What it still does NOT answer
 *
 * Whether this particular signal is good. Fundamentals and positioning are
 * weekly/monthly series and cannot be conditioned per-bar; they gate the
 * direction upstream (scoring, consensus) rather than the sample here. Read
 * the number as "this geometry, in this technical regime", not as the
 * strategy's win rate.
 */

export interface PlanBacktest {
  /** Sampled trades that ran to an exit (managed trades always do). */
  resolved: number;
  /** Trades whose net R was positive. */
  wins: number;
  losses: number;
  /** Always 0 under managed exits (the horizon closes at the market). */
  timeouts: number;
  /** wins / resolved, 0..1. Null when nothing resolved. */
  hitRate: number | null;
  /**
   * Mean R per trade, net of trading cost, measured on the managed walk —
   * the number the floors compare. Positive means the geometry, managed the
   * way the monitor manages it, has been historically worth taking.
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
  /**
   * Round-trip trading cost charged against every sampled trade, as a
   * percentage of entry. Never zero: a hit rate measured without spread
   * belongs to a strategy nobody can trade.
   */
  costPct?: number;
}

/**
 * Below this many resolved samples a conditioned walk is dropped in favour of
 * the unconditional one: a precise answer about the right question beats
 * nothing, but a noisy answer about the right question does not beat a solid
 * answer about a broader one — especially now that this number *chooses* the
 * plan's geometry.
 */
const MIN_CONDITIONED_RESOLVED = 30;

/**
 * Per-bar technical state, aligned to the candle array. Computed once per
 * candles array (WeakMap) because the geometry search backtests dozens of
 * combinations against the same history.
 */
interface RegimeSeries {
  ema50: number[];
  /** null where the series hasn't warmed up. */
  hist: (number | null)[];
  rsi14: (number | null)[];
}

const regimeCache = new WeakMap<Candle[], RegimeSeries>();

/**
 * The managed walk needs the full structure context (swings, CHoCH, ATR).
 * Cached per candles array because the geometry search backtests dozens of
 * combinations against the same history and the context is identical for all
 * of them.
 */
const labCtxCache = new WeakMap<Candle[], LabContext>();

function labCtxOf(candles: Candle[]): LabContext {
  const cached = labCtxCache.get(candles);
  if (cached) return cached;
  const built = buildContext(candles);
  labCtxCache.set(candles, built);
  return built;
}

function regimeOf(candles: Candle[]): RegimeSeries {
  const cached = regimeCache.get(candles);
  if (cached) return cached;
  const closes = candles.map((c) => c.close);
  const align = <T>(series: T[]): (T | null)[] => {
    const out: (T | null)[] = new Array(closes.length).fill(null);
    const offset = closes.length - series.length;
    for (let i = 0; i < series.length; i++) out[offset + i] = series[i];
    return out;
  };
  const built: RegimeSeries = {
    ema50: ema(closes, 50),
    hist: align(macd(closes).histogram),
    rsi14: align(rsi(closes, 14)),
  };
  regimeCache.set(candles, built);
  return built;
}

/** The similarity tiers, strongest first. `null` predicate = unconditional. */
interface Tier {
  label: string;
  conditioned: boolean;
  accept: ((i: number, close: number) => boolean) | null;
}

function tiersFor(direction: "long" | "short", candles: Candle[]): Tier[] {
  const r = regimeOf(candles);
  const emaSide = (i: number, close: number) =>
    direction === "long" ? close > r.ema50[i] : close < r.ema50[i];
  const macdSide = (i: number) => {
    const h = r.hist[i];
    return h !== null && (direction === "long" ? h > 0 : h < 0);
  };
  const rsiSide = (i: number) => {
    const v = r.rsi14[i];
    return v !== null && (direction === "long" ? v > 50 : v < 50);
  };
  const side = direction === "long" ? "多頭" : "空頭";
  return [
    {
      label: `EMA50 ${side}側＋MACD 同向＋RSI 同側（與當前訊號同條件的日子）`,
      conditioned: true,
      accept: (i, c) => emaSide(i, c) && macdSide(i) && rsiSide(i),
    },
    {
      label: `EMA50 ${side}側＋MACD 同向`,
      conditioned: true,
      accept: (i, c) => emaSide(i, c) && macdSide(i),
    },
    {
      label: `EMA50 ${side}側`,
      conditioned: true,
      accept: (i, c) => emaSide(i, c),
    },
    { label: "全部 K 棒，不分格局", conditioned: false, accept: null },
  ];
}

export function backtestPlanGeometry(
  direction: "long" | "short",
  entry: number,
  stopLoss: number,
  takeProfit: number,
  candles: Candle[],
  horizonBars = 20,
  /**
   * Whose spread to charge. Optional so an unknown or user-added instrument
   * still gets backtested — but never free: the fallback is the index cost,
   * not zero. A hit rate with no spread in it is the one number in this
   * system most likely to be believed and most likely to be wrong.
   */
  symbol?: string,
): PlanBacktest | null {
  const category =
    COMMODITIES.find((c) => c.symbol === symbol)?.category ?? "index";
  const cost = tradingCostFor(category);
  // The per-bar carry is charged over half the horizon: trades resolve
  // somewhere inside it, and assuming the full horizon would over-charge
  // every fast winner.
  const costFraction = totalCostFraction(cost, horizonBars / 2);

  const tiers = tiersFor(direction, candles);
  const skipped: string[] = [];
  let last: PlanBacktest | null = null;
  for (const tier of tiers) {
    const result = walk(direction, entry, stopLoss, takeProfit, candles, horizonBars, tier, costFraction);
    if (!result) continue;
    last = result;
    if (result.resolved >= MIN_CONDITIONED_RESOLVED) {
      if (skipped.length > 0) {
        result.basis = `${result.basis}（更嚴的條件層樣本不足：${skipped.join("、")}）`;
      }
      return result;
    }
    skipped.push(`「${tier.label}」僅 ${result.resolved} 筆`);
  }
  return last;
}

function walk(
  direction: "long" | "short",
  entry: number,
  stopLoss: number,
  takeProfit: number,
  candles: Candle[],
  horizonBars: number,
  tier: Tier,
  /** Round-trip cost as a fraction of entry. Never zero — see config/trading-costs.ts. */
  costFraction: number,
): PlanBacktest | null {
  if (entry <= 0 || candles.length < horizonBars + 20) return null;

  const slPct = Math.abs(entry - stopLoss) / entry;
  const tpPct = Math.abs(takeProfit - entry) / entry;
  if (!(slPct > 0) || !(tpPct > 0)) return null;
  // A target that cannot even cover the spread is not a trade at any hit
  // rate, and pretending otherwise is how a 100%-winning micro-scalp gets
  // recommended.
  if (tpPct <= costFraction) return null;

  const ctx = labCtxOf(candles);
  let wins = 0;
  let losses = 0;
  let sumR = 0;
  let hadAmbiguousBars = false;
  let sampled = 0;

  const lastStart = candles.length - horizonBars - 1;
  for (let i = 0; i <= lastStart; i++) {
    const e = candles[i].close;
    if (!(e > 0)) continue;
    if (tier.accept) {
      // The first bars of every indicator are still converging from their
      // seeds, so they are skipped rather than classified on numbers that are
      // mostly the first close.
      if (i < 50) continue;
      if (!tier.accept(i, e)) continue;
    }
    // The trailing buffer is measured in the entry bar's ATR; a bar without
    // one cannot be managed the way the live trade will be, so it is skipped
    // rather than simulated under different rules.
    const a = ctx.atr[i];
    if (a === null || !(a > 0)) continue;
    sampled++;

    const slLevel = direction === "long" ? e * (1 - slPct) : e * (1 + slPct);
    const tpLevel = direction === "long" ? e * (1 + tpPct) : e * (1 - tpPct);
    // The shared exit engine: breakeven at 1R, structure trailing, opposite
    // CHoCH exit, market close at the horizon, stop-first pessimism inside
    // each bar, cost charged against every exit. Identical to what the
    // monitor runs on the live position and what the lab measures.
    const exit = walkManaged({
      ctx,
      direction,
      firstBar: i + 1,
      entry: e,
      stop: slLevel,
      target: tpLevel,
      entryAtr: a,
      horizon: horizonBars,
      costFraction,
    });
    if (!exit) continue;
    // Both levels inside one bar still resolves pessimistically (the walk
    // checks the stop first); flag it so the caveat can be shown.
    const firstBarOfTrade = candles[exit.exitIndex];
    if (
      exit.kind === "stop" &&
      (direction === "long"
        ? firstBarOfTrade.high >= tpLevel
        : firstBarOfTrade.low <= tpLevel)
    ) {
      hadAmbiguousBars = true;
    }
    sumR += exit.r;
    if (exit.r > 0) wins++;
    else losses++;
  }

  const resolved = wins + losses;
  const hitRate = resolved > 0 ? wins / resolved : null;

  return {
    resolved,
    wins,
    losses,
    // Managed trades always exit — at a level, on a flip, or at the market
    // when the horizon runs out — so nothing can time out any more.
    timeouts: 0,
    hitRate: hitRate === null ? null : Math.round(hitRate * 1000) / 1000,
    expectancyR: resolved > 0 ? Math.round((sumR / resolved) * 100) / 100 : null,
    horizonBars,
    lookbackBars: sampled,
    hadAmbiguousBars,
    conditioned: tier.conditioned,
    costPct: Math.round(costFraction * 100 * 1000) / 1000,
    basis:
      `只取「${tier.label}」的 ${sampled} 根 K 棒為進場點，依實際執行的管理規則模擬` +
      `（觸及停利先平一半、剩餘保本追蹤、1R 保本、結構移停、反向 CHoCH 出場、逾時以市價結束），` +
      `已扣除來回交易成本 ${(costFraction * 100).toFixed(3)}%`,
  };
}

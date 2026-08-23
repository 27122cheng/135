import type { CommodityMeta } from "@/types/signal";

/**
 * 交易成本 — the number a backtest is most tempted to leave at zero.
 *
 * Every hit rate in this system decides whether a trade happens: the day
 * floor is 70%, the reference floor 55%. All of them were being measured on
 * *gross* moves — did price touch the target before the stop — with no
 * spread paid on either side. For a day trade whose stop sits under one ATR
 * away, a round-trip spread is a real slice of the target, and near a 70%
 * boundary it is exactly the slice that decides. A backtest that skips it
 * does not report a slightly optimistic number; it reports a different
 * strategy from the one the operator would actually be trading.
 *
 * ## Where these figures come from, and their honest status
 *
 * Retail-typical round-trip spreads for each instrument class, as a share of
 * price. They are deliberately on the pessimistic side of typical: a floor
 * that survives a wider spread survives a narrower one, and the failure
 * direction matters — under-charging invents trades that lose money, while
 * over-charging only costs some marginal ones. They are NOT this operator's
 * broker's actual costs, which nothing here can know; the figure used is
 * printed on the card so the assumption is arguable rather than buried.
 *
 * Overnight financing (swap) and futures roll are deliberately NOT modelled
 * as a fixed number: they are broker-specific, they change weekly, and their
 * sign flips with direction — a short JPY carry earns while the long pays.
 * Inventing an average would add a wrong number to a right one. The
 * per-bar carry below is a small, symmetric holding drag standing in for
 * "positions are not free to keep open", not a swap-rate model.
 */

export interface TradingCost {
  /** Round-trip spread + commission, as a percentage of entry price. */
  roundTripPct: number;
  /** Symmetric holding drag per bar held, as a percentage. */
  perBarPct: number;
}

export type CostCategory = CommodityMeta["category"];

const BY_CATEGORY: Record<CostCategory, TradingCost> = {
  // ~1.5 pips round trip on a 1.10 major.
  forex: { roundTripPct: 0.014, perBarPct: 0.0015 },
  // ~$0.60 round trip on gold near $4,000.
  metal: { roundTripPct: 0.018, perBarPct: 0.002 },
  // ~2–4 index points on the majors, plus the CFD financing drag.
  index: { roundTripPct: 0.02, perBarPct: 0.002 },
  // Oil is the widest of the four: ~$0.05 round trip on ~$65, and the
  // continuous contract pays a roll every month.
  energy: { roundTripPct: 0.08, perBarPct: 0.004 },
  // Spot crypto on a major venue: taker fees ~0.1% per side at retail tiers,
  // and perpetual funding commonly runs ~0.01%/8h. Pessimistic side of both,
  // per the house rule.
  crypto: { roundTripPct: 0.2, perBarPct: 0.03 },
};

export type TradingCostOverrides = Partial<Record<CostCategory, Partial<TradingCost>>>;

/**
 * 成本參數覆寫 — the operator's own broker figures, when they have set them.
 *
 * The defaults above are retail-typical guesses, stated as such; a floor
 * measured in expectancy is only as honest as the cost it charges, and the
 * operator's actual spread is a number only they know. Overrides are stored
 * in app_settings (key TRADING_COSTS_OVERRIDE, allowlisted) and applied at
 * the start of every code path that measures anything.
 *
 * Module state on purpose: tradingCostFor is called synchronously deep inside
 * the lab's exhaustive search and the plan backtest, and threading an async
 * settings read through those would put a database round-trip inside a hot
 * loop. One read per invocation at the entry point, then pure lookups.
 */
let activeOverrides: TradingCostOverrides = {};

const CATEGORIES: readonly CostCategory[] = ["forex", "metal", "index", "energy", "crypto"];

/**
 * Validates the stored JSON, field by field, dropping anything unsound.
 *
 * The bounds are load-bearing:
 *  - `roundTripPct` must be **strictly positive** — an override of zero would
 *    resurrect the free-spread backtest this file exists to prevent — and at
 *    most 1 (a 1% round trip is already several times the widest default;
 *    beyond it the operator has almost certainly typed pips into a percent
 *    field, and silently honouring the slip would fail every floor at once).
 *  - `perBarPct` may be zero (swap genuinely rounds to nothing on some
 *    accounts) but never negative, and at most 0.05%/bar for the same
 *    unit-slip reason.
 * Invalid fields are dropped individually so one typo does not discard the
 * other seven numbers.
 */
export function parseTradingCostOverrides(raw: string | null): TradingCostOverrides {
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: TradingCostOverrides = {};
  for (const category of CATEGORIES) {
    const v = (parsed as Record<string, unknown>)[category];
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const o = v as Record<string, unknown>;
    const entry: Partial<TradingCost> = {};
    if (
      typeof o.roundTripPct === "number" &&
      Number.isFinite(o.roundTripPct) &&
      o.roundTripPct > 0 &&
      o.roundTripPct <= 1
    ) {
      entry.roundTripPct = o.roundTripPct;
    }
    if (
      typeof o.perBarPct === "number" &&
      Number.isFinite(o.perBarPct) &&
      o.perBarPct >= 0 &&
      o.perBarPct <= 0.05
    ) {
      entry.perBarPct = o.perBarPct;
    }
    if (Object.keys(entry).length > 0) out[category] = entry;
  }
  return out;
}

export function setTradingCostOverrides(next: TradingCostOverrides): void {
  activeOverrides = next;
}

/** What is currently in force, for the settings page to display. */
export function activeTradingCostOverrides(): TradingCostOverrides {
  return activeOverrides;
}

export function tradingCostFor(category: CommodityMeta["category"]): TradingCost {
  const base = BY_CATEGORY[category] ?? BY_CATEGORY.index;
  const override = activeOverrides[category as CostCategory];
  return override ? { ...base, ...override } : base;
}

/** The untouched defaults, so the settings page can show what an override replaces. */
export function defaultTradingCostFor(category: CostCategory): TradingCost {
  return BY_CATEGORY[category];
}

/**
 * The whole cost of one round trip held for `bars`, as a share of entry.
 * Returned as a fraction (0.0002), not a percentage, because that is what
 * price arithmetic needs.
 */
export function totalCostFraction(cost: TradingCost, bars: number): number {
  return (cost.roundTripPct + cost.perBarPct * Math.max(0, bars)) / 100;
}

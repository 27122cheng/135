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

const BY_CATEGORY: Record<CommodityMeta["category"], TradingCost> = {
  // ~1.5 pips round trip on a 1.10 major.
  forex: { roundTripPct: 0.014, perBarPct: 0.0015 },
  // ~$0.60 round trip on gold near $4,000.
  metal: { roundTripPct: 0.018, perBarPct: 0.002 },
  // ~2–4 index points on the majors, plus the CFD financing drag.
  index: { roundTripPct: 0.02, perBarPct: 0.002 },
  // Oil is the widest of the four: ~$0.05 round trip on ~$65, and the
  // continuous contract pays a roll every month.
  energy: { roundTripPct: 0.08, perBarPct: 0.004 },
};

export function tradingCostFor(category: CommodityMeta["category"]): TradingCost {
  return BY_CATEGORY[category] ?? BY_CATEGORY.index;
}

/**
 * The whole cost of one round trip held for `bars`, as a share of entry.
 * Returned as a fraction (0.0002), not a percentage, because that is what
 * price arithmetic needs.
 */
export function totalCostFraction(cost: TradingCost, bars: number): number {
  return (cost.roundTripPct + cost.perBarPct * Math.max(0, bars)) / 100;
}

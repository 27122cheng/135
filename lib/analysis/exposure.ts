import type { CorrelationPair } from "./correlation";

/**
 * 同一個觀點下了幾次 —— which open positions are really the same bet as the
 * one being sized.
 *
 * ## Why the existing check was wrong in both directions
 *
 * The sizing card halved the position when any held symbol sat in a
 * correlation cluster with this one. It read the cluster list without its
 * sign and without either position's direction — so EURUSD long beside
 * USDJPY long (r strongly negative: those are *opposite* USD bets, a hedge)
 * halved the size, while EURUSD long beside XAUUSD long (r around 0.4, under
 * the cluster threshold, but both plainly short-USD) did not. It was cutting
 * the hedge and stacking the bet. The rule the code documented — "or sharing
 * a USD side" — was never implemented at all.
 *
 * Drawdown on this book comes from exactly that stack: three "different"
 * instruments that are one macro view, all stopping out on the same dollar
 * move. That is the 回撤過高 the operator reported, and no gate fixes it —
 * it is a sizing problem, and sizing is volume-neutral.
 *
 * ## The rule
 *
 * Two open positions are the same bet when either holds:
 *
 *  1. **USD side.** Every FX major and gold is a bet on the dollar once its
 *     quoting convention is unwound: long EURUSD, long GBPUSD and long gold
 *     are all short USD; long USDJPY is long USD. Same side, same bet, and
 *     no correlation window is needed to know it.
 *  2. **Signed correlation.** A cluster pair (|r| ≥ threshold) is the same
 *     bet when r is positive and the directions match, or r is negative and
 *     they oppose. The other two combinations are hedges and must not cut
 *     the size.
 *
 * Indices, energy and crypto have no USD side here — long SPX500 is risk-on
 * and loosely short-USD, but "loosely" is what the correlation window is
 * for, so they rely on rule 2 alone.
 *
 * ## The factor
 *
 * 1 / (1 + n): the n-th copy of one view risks 1/(n+1) each, so the whole
 * stack risks what one position would. The old binary 0.5 let a third
 * correlated position add a full 50% on top.
 */

export type UsdSide = "long-usd" | "short-usd";

/** The dollar bet a position amounts to, or null when it is not a dollar bet. */
export function usdSide(symbol: string, direction: "long" | "short"): UsdSide | null {
  const s = symbol.toUpperCase();
  // USD is the quote currency: long the pair = short the dollar.
  if (/^(EUR|GBP|AUD|NZD|XAU|XAG)USD$/.test(s)) {
    return direction === "long" ? "short-usd" : "long-usd";
  }
  // USD is the base currency: long the pair = long the dollar.
  if (/^USD(JPY|CHF|CAD)$/.test(s)) {
    return direction === "long" ? "long-usd" : "short-usd";
  }
  return null;
}

export interface HeldPositionRef {
  symbol: string;
  direction: "long" | "short";
}

export interface ExposureInput {
  symbol: string;
  direction: "long" | "short";
  /** Open real positions, excluding the one being sized. */
  held: HeldPositionRef[];
  /** Pairs at or beyond the cluster threshold, with their signed r. */
  clusters: Pick<CorrelationPair, "a" | "b" | "r">[];
}

export interface Exposure {
  /** Held symbols that are the same bet as this one. */
  related: string[];
  /** One line per related symbol, saying which rule matched. */
  reasons: string[];
  /** Risk multiplier: 1 / (1 + related.length). */
  factor: number;
}

export function correlatedExposure(input: ExposureInput): Exposure {
  const mine = usdSide(input.symbol, input.direction);
  const related: string[] = [];
  const reasons: string[] = [];

  for (const h of input.held) {
    if (h.symbol === input.symbol) continue;
    const theirs = usdSide(h.symbol, h.direction);
    if (mine !== null && theirs !== null && mine === theirs) {
      related.push(h.symbol);
      reasons.push(
        `${h.symbol} ${h.direction === "long" ? "做多" : "做空"}與本單同為${mine === "short-usd" ? "空美元" : "多美元"}`,
      );
      continue;
    }
    const pair = input.clusters.find(
      (c) =>
        (c.a === input.symbol && c.b === h.symbol) || (c.b === input.symbol && c.a === h.symbol),
    );
    if (!pair || pair.r === null) continue;
    const sameDirection = h.direction === input.direction;
    const sameBet = (pair.r > 0 && sameDirection) || (pair.r < 0 && !sameDirection);
    if (sameBet) {
      related.push(h.symbol);
      reasons.push(
        `${h.symbol} 與本商品 60 日相關係數 ${pair.r > 0 ? "+" : ""}${pair.r}，` +
          `${sameDirection ? "同向" : "反向"}持有等於同一個觀點`,
      );
    }
  }

  return { related, reasons, factor: 1 / (1 + related.length) };
}

/**
 * 連敗減碼 — the anti-martingale half of drawdown control.
 *
 * After two consecutive real losses the next position risks three-quarters;
 * after three or more, half. Sizing, not gating: the trade is still taken,
 * the journal still learns from it, and volume is untouched — but a run of
 * losses no longer compounds at full size while the system is measurably
 * out of step with the market. The factor releases on the first win.
 */
export function streakFactor(currentLossStreak: number): number {
  if (!(currentLossStreak >= 2)) return 1;
  return currentLossStreak >= 3 ? 0.5 : 0.75;
}

import type { EntryStructure } from "@/types/signal";

/**
 * 「這個結構離進場夠近嗎」 — one definition, used everywhere.
 *
 * ## The defect
 *
 * The rule was a flat 1.5% of price, written into four places. A percentage of
 * price is not a distance a market can feel; ATR is. What 1.5% buys differs by
 * a factor of four across the nine instruments:
 *
 * ```
 *   EURUSD  1.0800   1.5% = 162 pips   ≈ 2.7 × daily ATR   far too loose
 *   US30   53000     1.5% = 795 pts    ≈ 1.6 × daily ATR
 *   WTI       70     1.5% = $1.05      ≈ 0.7 × daily ATR   far too tight
 * ```
 *
 * So the same line of code meant "any structure in the neighbourhood" on FX and
 * "only structures inside one day's noise" on crude. On the loose end it let
 * levels the price would take days to reach count as protecting the entry — the
 * entry-structure score was inflated and the stop could be anchored somewhere
 * irrelevant. On the tight end it discarded perfectly good structure, which is
 * one of the reasons some symbols never produced a signal at all.
 *
 * ## The rule
 *
 * Two ATR. Far enough that a real support one day's range below the entry still
 * counts, close enough that a level a week away does not. ATR is per-instrument
 * by construction, so the same constant now means the same thing everywhere.
 *
 * The percentage survives only as the fallback for when ATR cannot be computed
 * — an arbitrary number is still better than accepting every structure on the
 * chart, and the caller says which rule was applied.
 */

/** Two ATR. The one number this module exists to make consistent. */
export const PROXIMITY_ATR = 2;

/** Used only when ATR is unavailable; the old rule, kept as a floor. */
export const PROXIMITY_FALLBACK_PCT = 1.5;

/**
 * Whether `structure` is close enough to `entry` to be treated as protecting it.
 *
 * `atr` null means the fallback percentage applies. Both branches use the
 * structure's own `distance_pct`, which the analyzers already computed against
 * the same entry, so nothing is recomputed and nothing can drift.
 */
export function isNearEntry(
  structure: Pick<EntryStructure, "price" | "distance_pct">,
  entryPrice: number,
  atr: number | null,
): boolean {
  if (atr && atr > 0 && entryPrice > 0) {
    return Math.abs(structure.price - entryPrice) <= atr * PROXIMITY_ATR;
  }
  return Math.abs(structure.distance_pct) <= PROXIMITY_FALLBACK_PCT;
}

/** How the rule was expressed this time, for the reason strings on the card. */
export function describeProximity(entryPrice: number, atr: number | null): string {
  return atr && atr > 0
    ? `距進場 ≤ ${PROXIMITY_ATR}×ATR(${Math.round(atr * 10000) / 10000})`
    : `距進場 ≤ ${PROXIMITY_FALLBACK_PCT}%（ATR 不可得，改用百分比）`;
}

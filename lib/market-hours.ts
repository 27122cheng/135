/**
 * 市場開了嗎 — because the system was announcing trades into a closed market.
 *
 * At 00:36 on a Sunday it sent "US30 做多 ▲ A+ 進場 53885.10". The exchange had
 * been shut since Friday evening and would not reopen for another day and a
 * half. The plan was not wrong so much as unplaceable: nobody could have taken
 * it, and by the time they could, the gap that opens a new week would have
 * moved the entry out from under it. Spot gold opened the following session
 * 2.4% above the previous close — an entry zone computed on Friday's last print
 * was not a near miss, it was a different market.
 *
 * ## Two independent tests, because either alone is wrong
 *
 * **The clock.** All nine instruments trade on the same weekly cycle — FX,
 * metals, energy and index CFDs run from Sunday evening to Friday evening, New
 * York time. That is a calendar fact, cheap to check, and it does not depend on
 * a feed telling the truth.
 *
 * **The last trade.** The clock cannot see a holiday, an outage, or a feed that
 * has quietly stopped updating. A quote whose last print is hours old says the
 * market is not trading *whatever the calendar thinks*, and that is exactly the
 * case a schedule-based check misses.
 *
 * Either one firing is enough to stop an alert. Neither is allowed to stop the
 * *analysis* — knowing where the levels are while the market is shut is useful,
 * and it is what Sunday evening preparation looks like. What must not happen is
 * a push notification saying to take a trade that cannot be placed.
 */

/** Weekly close: Friday 21:00 UTC (17:00 New York, allowing for either DST). */
const FRIDAY_CLOSE_UTC_HOUR = 21;
/** Weekly open: Sunday 22:00 UTC. Conservative — most venues are up by 21:00. */
const SUNDAY_OPEN_UTC_HOUR = 22;

/**
 * How stale a quote may be before the market is treated as shut.
 *
 * Three hours, not one. The free feed is delayed, thin instruments print
 * irregularly, and a quiet Asian session on WTI can genuinely go an hour
 * without a tick. Three hours is longer than any of that and far shorter than
 * a weekend, which is the case this exists to catch.
 */
export const STALE_QUOTE_HOURS = 3;

export interface MarketStatus {
  /** True when a trade should not be announced. The analysis still runs. */
  closed: boolean;
  /** Why, in words, for the card and the gap list. Null when open. */
  reason: string | null;
  /** Which test fired — the clock, the feed, or neither. */
  basis: "weekend" | "stale-quote" | "open";
}

/**
 * Whether the weekly session is running, from the clock alone.
 *
 * Exported so it can be tested against fixed instants rather than "now".
 */
export function isWeekendClosed(now: Date): boolean {
  const day = now.getUTCDay(); // 0 = Sunday
  const hour = now.getUTCHours();
  if (day === 6) return true; // all of Saturday
  if (day === 0 && hour < SUNDAY_OPEN_UTC_HOUR) return true;
  if (day === 5 && hour >= FRIDAY_CLOSE_UTC_HOUR) return true;
  return false;
}

/**
 * The verdict, from the clock and the feed together.
 *
 * `quoteAgeMinutes` null means no quote was available at all, which is not the
 * same as a closed market and is deliberately not treated as one — the analysis
 * already reports a missing quote as a data gap, and stacking a second
 * interpretation on top would obscure it.
 */
export function marketStatus(now: Date, quoteAgeMinutes: number | null): MarketStatus {
  if (isWeekendClosed(now)) {
    return {
      closed: true,
      reason: "週末休市（週五 21:00 UTC 收盤，週日 22:00 UTC 開盤），不發送進場通知",
      basis: "weekend",
    };
  }
  if (quoteAgeMinutes !== null && quoteAgeMinutes > STALE_QUOTE_HOURS * 60) {
    const hours = Math.round((quoteAgeMinutes / 60) * 10) / 10;
    return {
      closed: true,
      reason:
        `最後成交距今 ${hours} 小時（超過 ${STALE_QUOTE_HOURS} 小時），` +
        `市場可能休市或報價來源停更，不發送進場通知`,
      basis: "stale-quote",
    };
  }
  return { closed: false, reason: null, basis: "open" };
}

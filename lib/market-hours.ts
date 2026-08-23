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

/**
 * How old the newest H4 candle may be while still counting as trading.
 *
 * Looser than the quote threshold because a bar's timestamp is its *bucket
 * start*: an in-progress 4-hour bar opened at 00:00 is legitimately almost four
 * hours "old" at 03:50 while the market trades every second of it. Five hours
 * is one full bucket plus slack, and still far below the shortest real closure
 * this needs to catch (a US cash index's overnight gap runs ~13 hours).
 */
export const BAR_EVIDENCE_HOURS = 5;

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
 * The verdict, from the clock and *every* feed together.
 *
 * The quote alone turned out to be a witness that lies in both directions.
 * Yahoo's direct chart endpoint served this deployment data whose last trade
 * was 104 hours old on a Tuesday morning — with markets open and the candle
 * proxy (a different route) returning bars minutes old — so nine instruments
 * spent a trading day labelled 休市中 on the word of one broken feed. Candles
 * are independent evidence of trading, and either witness saying "the market
 * printed recently" is proof it did: prices do not print on a closed market.
 *
 * `null` for an age means that feed produced nothing, which is a data gap, not
 * a closed market — it is already reported as a gap, and stacking a second
 * interpretation on top would obscure it. Both feeds missing therefore reads
 * as open-with-gaps, never as closed.
 */
export function marketStatus(
  now: Date,
  quoteAgeMinutes: number | null,
  barAgeMinutes: number | null = null,
  /** The instrument's category — forex gets the 24/5 rule, crypto 24/7. */
  category?: string,
): MarketStatus {
  // Crypto never closes — not on weekends, not on holidays. The weekend
  // clock below is a fact about FX/metal/index/energy venues, and applying
  // it to BTCUSD produced 週末休市 over a market printing every second.
  // Feed staleness on crypto is a data gap (already reported as one), never
  // a closed market.
  if (category === "crypto") return { closed: false, reason: null, basis: "open" };

  if (isWeekendClosed(now)) {
    return {
      closed: true,
      reason: "週末休市（週五 21:00 UTC 收盤，週日 22:00 UTC 開盤），不發送進場通知",
      basis: "weekend",
    };
  }

  // FX is open 24/5 as a fact about the market, not about any feed: between
  // the Sunday open and the Friday close there is no hour in which EURUSD
  // does not trade somewhere. A midweek "closed" verdict on a currency pair
  // is therefore always a false positive — it was our feeds lagging (Yahoo
  // hours behind, Stooq breaker tripped, ER-API's daily fix) being read as
  // the market stopping. Staleness on FX stays visible as gap lines and the
  // price-basis note; it just can't call the market shut.
  if (category === "forex") return { closed: false, reason: null, basis: "open" };

  const quoteFresh = quoteAgeMinutes !== null && quoteAgeMinutes <= STALE_QUOTE_HOURS * 60;
  const barFresh = barAgeMinutes !== null && barAgeMinutes <= BAR_EVIDENCE_HOURS * 60;
  if (quoteFresh || barFresh) return { closed: false, reason: null, basis: "open" };
  if (quoteAgeMinutes === null && barAgeMinutes === null) {
    return { closed: false, reason: null, basis: "open" };
  }

  const ages = [quoteAgeMinutes, barAgeMinutes].filter((a): a is number => a !== null);
  const hours = Math.round((Math.min(...ages) / 60) * 10) / 10;
  return {
    closed: true,
    reason:
      `最後成交距今 ${hours} 小時（報價與 K 棒都沒有更新的跡象），` +
      `市場休市中或所有價格來源停更，不發送進場通知`,
    basis: "stale-quote",
  };
}

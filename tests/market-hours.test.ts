import { check, report } from "./_harness";
import { isWeekendClosed, marketStatus, STALE_QUOTE_HOURS } from "@/lib/market-hours";
import { shouldAlert } from "@/lib/notify/alert";
import type { SignalRow, TradeSignal } from "@/types/signal";

/**
 * 「今天明明沒有開盤為什麼會有交易信號」.
 *
 * At 00:36 on a Sunday the system pushed "US30 做多 ▲ A+ 進場 53885.10". The
 * exchange had been shut since Friday evening and would not reopen for another
 * day and a half. Worse, the card said the price it used was "0 分鐘前": Yahoo
 * keeps emitting a bar for the current five-minute boundary over a weekend,
 * carrying Friday's close forward, so the bar timestamp said *now* while the
 * last trade was forty hours old.
 *
 * Two tests, because either alone is wrong. The clock cannot see a holiday or a
 * dead feed; the feed cannot be trusted to admit it has stopped.
 */

const at = (iso: string) => new Date(iso);

// ── the weekly cycle ──────────────────────────────────────────────
{
  // Friday 21:00 UTC is the close; Sunday 22:00 UTC is the open.
  check("Friday afternoon is open", !isWeekendClosed(at("2026-08-07T15:00:00Z")));
  check("Friday 20:59 is still open", !isWeekendClosed(at("2026-08-07T20:59:00Z")));
  check("Friday 21:00 is closed", isWeekendClosed(at("2026-08-07T21:00:00Z")));
  check("all of Saturday is closed", isWeekendClosed(at("2026-08-08T12:00:00Z")));
  check("Saturday night is closed", isWeekendClosed(at("2026-08-08T23:00:00Z")));
  check("Sunday morning is closed", isWeekendClosed(at("2026-08-09T09:00:00Z")));
  // The screenshot: 00:36 local on a Sunday.
  check("Sunday 00:36 UTC is closed", isWeekendClosed(at("2026-08-09T00:36:00Z")));
  check("Sunday 21:59 is still closed", isWeekendClosed(at("2026-08-09T21:59:00Z")));
  check("Sunday 22:00 is open again", !isWeekendClosed(at("2026-08-09T22:00:00Z")));
  check("Monday is open", !isWeekendClosed(at("2026-08-10T03:00:00Z")));
}

// ── the two tests together ────────────────────────────────────────
{
  const weekend = marketStatus(at("2026-08-09T00:36:00Z"), 5);
  check("the weekend closes it even with a fresh-looking quote", weekend.closed);
  check("and says which test fired", weekend.basis === "weekend", weekend);
  check("with the reopen time in words", weekend.reason?.includes("週日") === true, weekend.reason);

  // Midweek, but the last print is old — a holiday, an outage, a dead feed.
  // The clock cannot see any of those.
  const stale = marketStatus(at("2026-08-12T10:00:00Z"), STALE_QUOTE_HOURS * 60 + 1);
  check("a stale quote closes it midweek", stale.closed, stale);
  check("and is distinguished from the weekend", stale.basis === "stale-quote", stale);
  check("quoting how old the last trade is", stale.reason?.includes("小時") === true, stale.reason);

  const open = marketStatus(at("2026-08-12T10:00:00Z"), 4);
  check("a normal weekday with a live quote is open", !open.closed, open);
  check("and needs no explanation", open.reason === null);

  // A delayed free feed goes quiet for a while in thin sessions; that is not a
  // closed market, and treating it as one would silence the app most nights.
  const delayed = marketStatus(at("2026-08-12T10:00:00Z"), 90);
  check("a 90-minute-old quote is still open", !delayed.closed, delayed);

  // No quote at all is a data gap, already reported as one. Reading it as
  // "closed" would put a second interpretation on top of the first.
  const noQuote = marketStatus(at("2026-08-12T10:00:00Z"), null);
  check("a missing quote is not a closed market", !noQuote.closed, noQuote);
}

// ── and it stops the notification, not the analysis ───────────────
{
  const tradeable = {
    symbol: "US30",
    grade: "A+",
    direction: "long",
    interventions: [],
    data_gaps: [],
    news_digest: null,
    market_closed: true,
    market_closed_reason: "週末休市（週五 21:00 UTC 收盤，週日 22:00 UTC 開盤），不發送進場通知",
    trade_plan: {
      stance: "enter",
      entry: 53885.1,
      stop_loss: 53160.77,
      take_profit: 54744.33,
      risk_reward: 1.19,
      summary: "s",
      add_ons: [],
    },
  } as unknown as TradeSignal;

  const decision = shouldAlert(tradeable, null, "A");
  check("a closed market suppresses the alert", !decision.alert, decision);
  check("and the reason is the market's, not the plan's",
    decision.reason.includes("休市"), decision.reason);

  // The identical signal on an open market still alerts — the gate must be the
  // market, not something that quietly disabled alerting altogether.
  const open = { ...tradeable, market_closed: false, market_closed_reason: null } as TradeSignal;
  check("the same plan alerts when the market is open", shouldAlert(open, null, "A").alert);

  // And it outranks every other reason, including a withdrawal: there is
  // nothing to withdraw into when nobody could have entered.
  const previouslyEntered = {
    symbol: "US30",
    grade: "A+",
    trade_plan: { stance: "enter", entry: 1, stop_loss: 0, take_profit: 2 },
  } as unknown as SignalRow;
  const waitingClosed = {
    ...tradeable,
    trade_plan: { ...tradeable.trade_plan, stance: "wait" },
  } as unknown as TradeSignal;
  check("a withdrawal during a closed market also stays quiet",
    !shouldAlert(waitingClosed, previouslyEntered, "A").alert);
}

report("market hours");

import { readFileSync } from "node:fs";
import { check, report } from "./_harness";
import { isWeekendClosed, marketStatus, STALE_QUOTE_HOURS } from "@/lib/market-hours";
import { freshestBar } from "@/lib/signal-builder";
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

// ── the candles are a second witness ──────────────────────────────
//
// The Tuesday incident: Yahoo's direct endpoint served quotes whose last trade
// was 104 hours old while the candle proxy had bars minutes old, and nine open
// instruments spent a trading day labelled 休市中 on the word of the one
// broken feed. Prices do not print on a closed market, so either witness
// saying "it printed recently" is proof the market is open.
{
  const tue = at("2026-08-11T05:00:00Z");
  const brokenQuote = marketStatus(tue, 104 * 60, 45);
  check("a fresh bar overrides a four-day-old quote", !brokenQuote.closed, brokenQuote);

  const brokenBars = marketStatus(tue, 20, 30 * 60);
  check("and a fresh quote overrides stale bars", !brokenBars.closed, brokenBars);

  // An in-progress H4 bar is legitimately almost four hours "old" at its
  // bucket's end while the market trades every second of it.
  const bucketEnd = marketStatus(tue, null, 230);
  check("a bar at its bucket's end still counts as trading", !bucketEnd.closed, bucketEnd);

  // Both witnesses stale is the real overnight close of a cash index.
  const overnight = marketStatus(tue, 350, 350);
  check("both feeds stale reads as closed", overnight.closed, overnight);
  check("and the reason names both", overnight.reason?.includes("K 棒") === true,
    overnight.reason);

  const nothing = marketStatus(tue, null, null);
  check("no evidence at all is still not a closed market", !nothing.closed);
}

// ── FX is open 24/5 as a fact about the market ────────────────────
//
// Between the Sunday open and the Friday close there is no hour in which a
// major pair does not trade somewhere, so a midweek "closed" on forex is
// always our feeds lagging, never the market stopping. The weekend clock is
// unaffected — it outranks everything.
{
  const tue = at("2026-08-11T19:00:00Z");
  const laggingFeeds = marketStatus(tue, 6 * 60, 7 * 60, "forex");
  check("stale feeds cannot close a currency pair midweek", !laggingFeeds.closed, laggingFeeds);

  const sameForIndex = marketStatus(tue, 6 * 60, 7 * 60, "index");
  check("an index with the same staleness still reads closed", sameForIndex.closed);

  const weekend = marketStatus(at("2026-08-09T00:36:00Z"), 5, 5, "forex");
  check("the weekend clock still outranks the forex rule", weekend.closed, weekend);
}

// ── the bar witness is the freshest bar, not the first that exists ──
//
// The second half of the Tuesday incident: the quote was cured of
// existence-beats-freshness, but the bar witness still read
// `h4 ?? d1 ?? w1`. H4 has no Stooq fallback, so a Yahoo freeze left H4
// holding week-old last-resort bars — which *existed*, and therefore hid the
// fresh Stooq D1 bar behind them. Symbols whose Stooq quote also failed
// stayed 休市中 while their own D1 candles disproved it.
{
  const frozenH4 = { time: "2026-08-06T16:00:00.000Z", close: 23100 };
  const stooqD1 = { time: "2026-08-10T00:00:00.000Z", close: 23750 };
  const oldW1 = { time: "2026-08-04T00:00:00.000Z", close: 22900 };
  check("a fresh D1 bar outranks a frozen H4 one",
    freshestBar(frozenH4, stooqD1, oldW1) === stooqD1);

  const liveH4 = { time: "2026-08-11T04:00:00.000Z", close: 23800 };
  check("intraday the live H4 bucket still wins",
    freshestBar(liveH4, stooqD1, oldW1) === liveH4);

  check("missing feeds are skipped", freshestBar(undefined, stooqD1) === stooqD1);
  check("no bars at all is still no bar", freshestBar(undefined, undefined) === undefined);

  // And the builder actually uses it — the `??` chain must not come back.
  const builder = readFileSync("lib/signal-builder.ts", "utf8");
  check("the builder picks its bar witness by freshness",
    builder.includes("freshestBar(h4?.candles.at(-1)"), undefined);
  check("and the existence-beats-freshness chain is gone",
    !builder.includes("h4?.candles.at(-1) ?? d1?.candles.at(-1)"), undefined);
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
    bias_items: [
      { dimension: "技術面", factor: "f", direction: "long", weight: 2, evidence: "e", source: "s" },
      { dimension: "基本面", factor: "f", direction: "long", weight: 1, evidence: "e", source: "s" },
      { dimension: "籌碼面", factor: "f", direction: "long", weight: 1, evidence: "e", source: "s" },
    ],
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

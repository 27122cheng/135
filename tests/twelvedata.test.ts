import { check, report, stubFetch } from "./_harness";
import { __resetCacheForTests } from "@/lib/data-sources/cache";
import { __resetQuotaForTests } from "@/lib/data-sources/quota";
import {
  fetchTwelveDataOHLCV,
  fetchTwelveDataQuote,
  twelveDataSymbol,
} from "@/lib/data-sources/twelvedata";
import { COMMODITIES } from "@/types/signal";

/**
 * Twelve Data — the optional third live quote witness.
 *
 * The properties that matter are all about not making things worse: no key
 * means no call at all, an error body dressed as HTTP 200 is a failure and not
 * a price, and the timestamp is the vendor's own print time rather than now()
 * — a source that stamps itself with the current clock would win every
 * freshness contest by construction, which is exactly the bug the freshness
 * rule exists to catch.
 */

function reset() {
  __resetQuotaForTests();
  __resetCacheForTests();
  delete process.env.TWELVEDATA_API_KEY;
}

async function main() {
  // ── the mapping covers every instrument ─────────────────────────
  {
    const unmapped = COMMODITIES.filter((c) => twelveDataSymbol(c.symbol) === null);
    check("every built-in symbol maps to a Twelve Data ticker",
      unmapped.length === 0, unmapped.map((c) => c.symbol));
    check("FX uses the slash form", twelveDataSymbol("EURUSD") === "EUR/USD");
    check("and GER40 — the one with no keyless third source — is covered",
      twelveDataSymbol("GER40") === "GDAXI");
    check("an unknown symbol maps to nothing", twelveDataSymbol("NOPE") === null);
  }

  // ── no key, no call ─────────────────────────────────────────────
  {
    reset();
    const seen = stubFetch(() => ({ status: 200, json: { close: "1.1", timestamp: 1 } }));
    const gaps: string[] = [];
    const r = await fetchTwelveDataQuote({ symbol: "EURUSD" }, gaps);
    check("without a key it returns null", r === null);
    check("and makes no request at all", seen.length === 0, seen);
    check("and reports no gap — an unconfigured optional source is not a failure",
      gaps.length === 0, gaps);
  }

  // ── a real quote ────────────────────────────────────────────────
  {
    reset();
    process.env.TWELVEDATA_API_KEY = "k";
    const at = Math.floor(Date.now() / 1000) - 120;
    stubFetch(() => ({ status: 200, json: { symbol: "EUR/USD", close: "1.0842", timestamp: at } }));
    const gaps: string[] = [];
    const r = await fetchTwelveDataQuote({ symbol: "EURUSD" }, gaps);
    check("a quote comes back", r !== null, r);
    check("with the vendor's price", r?.price === 1.0842, r?.price);
    check("stamped with the vendor's print time, not now",
      Math.abs(new Date(r!.at).getTime() - at * 1000) < 1000, r?.at);
    check("and an age derived from it", r!.ageMinutes >= 1.9 && r!.ageMinutes <= 2.6, r?.ageMinutes);
    check("labelled as its own source", r?.source === "twelvedata", r?.source);
  }

  // ── an error body behind HTTP 200 ───────────────────────────────
  //
  // The vendor answers 200 with `{code, message, status:"error"}` for a bad
  // key and for a plan limit, so the transport layer sees success. Treating
  // that as a price would put a `NaN` — or worse, a stale cached number — into
  // the entry-zone calculation.
  {
    reset();
    process.env.TWELVEDATA_API_KEY = "k";
    stubFetch(() => ({
      status: 200,
      json: {
        code: 403,
        message: "/quote is not available with your plan. Consider upgrading.",
        status: "error",
      },
    }));
    const gaps: string[] = [];
    const r = await fetchTwelveDataQuote({ symbol: "NAS100" }, gaps);
    check("a plan-limited answer is not a price", r === null);
    check("and says so, quoting the vendor", gaps.some((g) => g.includes("upgrading")), gaps);
    check("naming it as a plan limit rather than an outage",
      gaps.some((g) => g.includes("免費方案不含此商品類別")), gaps);
  }

  // ── a malformed answer is refused, not guessed at ───────────────
  {
    reset();
    process.env.TWELVEDATA_API_KEY = "k";
    stubFetch(() => ({ status: 200, json: { symbol: "EUR/USD", close: "not-a-number" } }));
    check("a non-numeric price is refused",
      (await fetchTwelveDataQuote({ symbol: "EURUSD" }, [])) === null);

    reset();
    process.env.TWELVEDATA_API_KEY = "k";
    stubFetch(() => ({ status: 200, json: { symbol: "EUR/USD", close: "1.08" } }));
    check("a price with no timestamp is refused — an unstamped quote would win every freshness contest",
      (await fetchTwelveDataQuote({ symbol: "EURUSD" }, [])) === null);
  }

  // ── an unmapped symbol never reaches the network ────────────────
  {
    reset();
    process.env.TWELVEDATA_API_KEY = "k";
    const seen = stubFetch(() => ({ status: 200, json: { close: "1", timestamp: 1 } }));
    check("an unmapped symbol returns null",
      (await fetchTwelveDataQuote({ symbol: "NOPE" }, [])) === null);
    check("without spending a request", seen.length === 0, seen);
  }

  // ── the OHLCV series — the candle chain's fourth leg ────────────
  {
    reset();
    process.env.TWELVEDATA_API_KEY = "k";
    // The vendor answers newest-first; consumers walk oldest-first.
    const seen = stubFetch(() => ({
      status: 200,
      json: {
        status: "ok",
        values: [
          { datetime: "2026-08-21 08:00:00", open: "101", high: "102", low: "100", close: "101.5", volume: "0" },
          { datetime: "2026-08-21 04:00:00", open: "100", high: "101", low: "99", close: "100.5", volume: "0" },
        ],
      },
    }));
    const gaps: string[] = [];
    const candles = await fetchTwelveDataOHLCV({ symbol: "EURUSD" }, "H4", gaps, {
      outputsize: 500,
      ttlMs: 60_000,
    });
    check("a series comes back oldest-first",
      candles?.length === 2 && candles[0].close === 100.5 && candles[1].close === 101.5,
      candles);
    check("intraday rows are stamped as UTC",
      candles?.[0].time === "2026-08-21T04:00:00.000Z", candles?.[0].time);
    check("H4 asks for the native 4h interval — no resampling",
      seen.some((u) => u.includes("interval=4h")), seen);
    check("a zero FX volume reads as not-measured, never as no-trading",
      candles?.every((c) => c.volume === null) === true, candles);

    reset();
    process.env.TWELVEDATA_API_KEY = "k";
    stubFetch(() => ({
      status: 200,
      json: { status: "error", code: 429, message: "You have run out of API credits" },
    }));
    const gaps2: string[] = [];
    check("an HTTP-200 error body is a failure, not a series",
      (await fetchTwelveDataOHLCV({ symbol: "EURUSD" }, "D1", gaps2, { outputsize: 400, ttlMs: 60_000 })) ===
        null);
    check("with the vendor's own message quoted",
      gaps2.some((g) => g.includes("credits")), gaps2);

    reset();
    const seen3 = stubFetch(() => ({ status: 200, json: { status: "ok", values: [] } }));
    check("no key, no call, no gap",
      (await fetchTwelveDataOHLCV({ symbol: "EURUSD" }, "D1", [], { outputsize: 400, ttlMs: 60_000 })) ===
        null && seen3.length === 0,
      seen3);
  }

  report("Twelve Data 報價");
}

void main();

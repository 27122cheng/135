import { check, report, stubFetch } from "./_harness";
import { __resetCacheForTests } from "@/lib/data-sources/cache";
import { __resetQuotaForTests } from "@/lib/data-sources/quota";
import {
  fetchSwissquoteQuote,
  pickSwissquoteQuote,
  swissquotePair,
} from "@/lib/data-sources/swissquote";
import { COMMODITIES } from "@/types/signal";

/**
 * Swissquote — an independent keyless spot quote, added because gold's four
 * existing live legs failed simultaneously in production and the chain fell
 * through to a 14.5-hour-old daily backup. Past the monitor's own 3-hour
 * liveness bound that is not a degraded quote, it is no tracking at all.
 *
 * Two properties matter most here and both are about not making things worse:
 * the mapping never reaches a futures-basis instrument (the basis bug this
 * codebase already paid for once), and an unexpected response is a reported
 * failure rather than a guessed price.
 */

function reset() {
  __resetQuotaForTests();
  __resetCacheForTests();
}

const platform = (bid: number, ask: number, ts: number, profile = "Prime") => ({
  topo: { platform: "MT5", server: "Live" },
  spreadProfilePrices: [{ spreadProfile: profile, bid, ask }],
  ts,
});

async function main() {
  // ── the mapping is spot-only, deliberately ──────────────────────
  {
    check("gold is covered — the instrument that needed this", swissquotePair("XAUUSD") === "XAU/USD");
    check("and the FX majors with it",
      swissquotePair("EURUSD") === "EUR/USD" &&
        swissquotePair("USDJPY") === "USD/JPY" &&
        swissquotePair("GBPUSD") === "GBP/USD");

    // The load-bearing one. This feed quotes spot; every symbol it answers
    // for must declare spot. Serving a futures-basis instrument a spot price
    // is the exact bug that had the site quoting gold 1.28% above the real
    // market, and it would be silent — a plausible number for the wrong
    // instrument.
    const wrongBasis = COMMODITIES.filter(
      (c) => swissquotePair(c.symbol) !== null && c.contractBasis !== "spot",
    );
    check("no futures-basis instrument is mapped to this spot feed",
      wrongBasis.length === 0, wrongBasis.map((c) => `${c.symbol}:${c.contractBasis}`));
    check("the index and energy symbols are simply not answered",
      ["NAS100", "GER40", "US30", "SPX500", "WTI"].every((s) => swissquotePair(s) === null));
    check("an unknown symbol maps to nothing", swissquotePair("NOPE") === null);
  }

  // ── picking a quote out of the response ─────────────────────────
  {
    const ts = Date.now() - 60_000;
    const picked = pickSwissquoteQuote([
      platform(4326.0, 4327.0, ts, "Retail"),
      platform(4326.4, 4326.6, ts, "Prime"),
    ]);
    check("the tightest spread wins", picked?.price === 4326.5, picked);
    check("stamped with the vendor's time, not now",
      picked !== null && Math.abs(new Date(picked.at).getTime() - ts) < 1000, picked?.at);

    // Every rejection below would otherwise produce a confident wrong number.
    check("an unstamped quote is refused",
      pickSwissquoteQuote([{ spreadProfilePrices: [{ bid: 1, ask: 1.1 }] }]) === null);
    check("epoch seconds mistaken for milliseconds are refused",
      pickSwissquoteQuote([platform(4326, 4327, Math.floor(Date.now() / 1000))]) === null);
    check("a crossed book is refused",
      pickSwissquoteQuote([platform(4327, 4326, ts)]) === null);
    check("a non-positive price is refused",
      pickSwissquoteQuote([platform(0, 1, ts)]) === null);
    // A book with the quotes pulled goes very wide; that is not a live market.
    check("an absurd spread is refused",
      pickSwissquoteQuote([platform(4000, 4400, ts)]) === null);
    check("a wide profile is skipped in favour of a sane one",
      pickSwissquoteQuote([platform(4000, 4400, ts, "Wide"), platform(4326.4, 4326.6, ts)])
        ?.price === 4326.5);

    check("a shape that is not an array is refused", pickSwissquoteQuote({ price: 1 }) === null);
    check("an empty array is refused", pickSwissquoteQuote([]) === null);
    check("junk entries are skipped, not thrown on",
      pickSwissquoteQuote([null, 7, "x", platform(4326.4, 4326.6, ts)])?.price === 4326.5);
  }

  // ── the fetch wrapper ───────────────────────────────────────────
  {
    reset();
    const ts = Date.now() - 90_000;
    let requested = "";
    stubFetch((url) => {
      requested = String(url);
      return { status: 200, json: [platform(4326.4, 4326.6, ts)] };
    });
    const gaps: string[] = [];
    const q = await fetchSwissquoteQuote({ symbol: "XAUUSD" }, gaps);
    check("a quote comes back with the vendor's mid", q?.price === 4326.5, q);
    check("labelled as its own source", q?.source === "swissquote", q?.source);
    check("aged from the vendor's stamp", q !== null && q.ageMinutes > 1 && q.ageMinutes < 3,
      q?.ageMinutes);
    check("and it asked for the right pair", requested.includes("XAU/USD"), requested);
    check("a good answer reports no gap", gaps.length === 0, gaps);
  }

  {
    reset();
    stubFetch(() => ({ status: 200, json: { unexpected: true } }));
    const gaps: string[] = [];
    check("a shape change is a failure, not a price",
      (await fetchSwissquoteQuote({ symbol: "XAUUSD" }, gaps)) === null);
    check("and it is reported", gaps.length > 0, gaps);
  }

  {
    reset();
    stubFetch(() => ({ status: 503, body: "upstream down" }));
    const gaps: string[] = [];
    check("an HTTP error is a failure, not a price",
      (await fetchSwissquoteQuote({ symbol: "XAUUSD" }, gaps)) === null);
    check("and it is reported by name", gaps.some((g) => g.includes("Swissquote")), gaps);
  }

  {
    reset();
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(String(url));
      return { status: 200, json: [] };
    });
    check("an unmapped symbol is never requested at all",
      (await fetchSwissquoteQuote({ symbol: "NAS100" }, [])) === null && seen.length === 0, seen);
  }

  report("Swissquote 報價");
}

void main();

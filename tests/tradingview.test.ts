import { check, report, stubFetch } from "./_harness";
import { __resetCacheForTests } from "@/lib/data-sources/cache";
import { __resetQuotaForTests } from "@/lib/data-sources/quota";
import { fetchTradingViewQuote, tradingViewSymbol } from "@/lib/data-sources/tradingview";
import { COMMODITIES } from "@/types/signal";

/**
 * TradingView — the fifth live quote witness, keyless and unofficial.
 *
 * Unofficial is the operative word: the endpoint owes us nothing, so the
 * properties pinned here are all about failing loudly instead of guessing —
 * a shape change is a reported failure, an unstamped price is refused, and
 * the mapping covers every built-in (it exists mostly for the instruments
 * with the fewest keyless witnesses, GER40 above all).
 */

function reset() {
  __resetQuotaForTests();
  __resetCacheForTests();
}

async function main() {
  // ── the mapping covers every instrument, on the right basis ─────
  {
    const unmapped = COMMODITIES.filter((c) => tradingViewSymbol(c.symbol) === null);
    check("every built-in maps to a TradingView symbol", unmapped.length === 0,
      unmapped.map((c) => c.symbol));
    check("gold maps to OANDA spot — the symbol's declared basis",
      tradingViewSymbol("XAUUSD") === "OANDA:XAUUSD");
    check("GER40 — the instrument with the fewest keyless witnesses — is covered",
      tradingViewSymbol("GER40") === "OANDA:DE30EUR");
    check("an unknown symbol maps to nothing", tradingViewSymbol("NOPE") === null);
  }

  // ── a real quote ────────────────────────────────────────────────
  {
    reset();
    const at = Math.floor(Date.now() / 1000) - 90;
    stubFetch(() => ({ status: 200, json: { lp: 2412.35, lp_time: at } }));
    const gaps: string[] = [];
    const q = await fetchTradingViewQuote({ symbol: "XAUUSD" }, gaps);
    check("a quote comes back with the vendor's price", q?.price === 2412.35, q);
    check("stamped with the vendor's print time, not now",
      q !== null && Math.abs(new Date(q.at).getTime() - at * 1000) < 1000, q?.at);
    check("labelled as its own source", q?.source === "tradingview", q?.source);
    check("a clean answer reports no gap", gaps.length === 0, gaps);
  }

  // ── failure modes fail loudly, never guess ──────────────────────
  {
    reset();
    stubFetch(() => ({ status: 200, json: { lp: 2412.35 } }));
    check("a price with no timestamp is refused",
      (await fetchTradingViewQuote({ symbol: "XAUUSD" }, [])) === null);

    reset();
    const gaps: string[] = [];
    stubFetch(() => ({ status: 200, json: { s: "error", errmsg: "unknown symbol" } }));
    check("a shape change is a failure, not a price",
      (await fetchTradingViewQuote({ symbol: "XAUUSD" }, gaps)) === null);
    check("and says the endpoint is unofficial", gaps.some((g) => g.includes("非官方")), gaps);

    reset();
    const seen = stubFetch(() => ({ status: 200, json: { lp: 1, lp_time: 1 } }));
    check("an unmapped symbol never reaches the network",
      (await fetchTradingViewQuote({ symbol: "NOPE" }, [])) === null && seen.length === 0, seen);
  }

  report("TradingView 報價");
}

void main();

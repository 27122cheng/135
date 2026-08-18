import { check, report } from "./_harness";
import { basisNote } from "@/lib/data-sources/instrument-basis";
import { COMMODITIES } from "@/types/signal";
import { fmpSymbol } from "@/lib/data-sources/fmp";
import { twelveDataSymbol } from "@/lib/data-sources/twelvedata";

/**
 * 期貨還是現貨.
 *
 * The bug: gold was mapped to `GC=F`, the COMEX futures contract, while Stooq,
 * Twelve Data and gold-api all served spot. The site quoted 4,448.00 against a
 * broker's spot 4,391.62 — above a spot high that day of 4,436.05, so it was
 * not a stale price or a wrong price, it was a *different instrument*. Which
 * one you saw depended on which source answered first, which is exactly what
 * "every price is different" means.
 *
 * What is pinned here is that the mapping cannot silently drift back: every
 * symbol declares its basis, gold's sources all agree on spot, and a source
 * that returns something else has to say so.
 */

// ── every symbol declares what it is about ────────────────────────
{
  check("every instrument declares a contract basis",
    COMMODITIES.every((c) => c.contractBasis === "spot" || c.contractBasis === "futures"),
    COMMODITIES.filter((c) => !c.contractBasis).map((c) => c.symbol));

  const gold = COMMODITIES.find((c) => c.symbol === "XAUUSD")!;
  check("gold is spot — the instrument people actually trade",
    gold.contractBasis === "spot", gold.contractBasis);
  check("and its primary ticker is the spot one, not the futures contract",
    gold.yfinanceSymbol === "XAUUSD=X", gold.yfinanceSymbol);
  check("its Stooq ticker is spot too", gold.stooqSymbol === "xauusd");
  check("as is its Twelve Data ticker", twelveDataSymbol("XAUUSD") === "XAU/USD");
  check("and its FMP ticker — GCUSD would be the futures contract again",
    fmpSymbol("XAUUSD") === "XAUUSD", fmpSymbol("XAUUSD"));

  // The index CFDs stay on futures deliberately: the cash indices only print
  // during their exchange session, which is what made US30 read 休市中 through
  // every pre-market.
  for (const symbol of ["NAS100", "US30", "SPX500"]) {
    const meta = COMMODITIES.find((c) => c.symbol === symbol)!;
    check(`${symbol} tracks futures, as the CFD does`, meta.contractBasis === "futures");
    check(`and its ticker is the futures contract`, meta.yfinanceSymbol.endsWith("=F"),
      meta.yfinanceSymbol);
  }
}

// ── a source quoting something else has to say so ─────────────────
{
  check("gold's sources all agree, so nothing is announced",
    basisNote("XAUUSD", "spot", "stooq") === null &&
      basisNote("XAUUSD", "spot", "twelvedata") === null &&
      basisNote("XAUUSD", "spot", "fmp") === null);

  // The index fallbacks are cash while the symbol is about futures. The price
  // is still used — it is the best available — but the basis is stated, or the
  // reader compares it against a broker screen and concludes we are broken.
  const note = basisNote("NAS100", "futures", "stooq");
  check("a cash-index fallback on a futures symbol is announced", note !== null);
  check("naming which is which", note!.includes("現貨指數") && note!.includes("期貨"), note);
  check("and saying the price is still what the levels were built on",
    note!.includes("價位仍以此為準"), note);

  check("the primary source raises nothing",
    basisNote("NAS100", "futures", "yahoo-direct") === null);
  check("an unknown source raises nothing rather than guessing",
    basisNote("NAS100", "futures", "some-new-vendor") === null);
  check("no source at all raises nothing", basisNote("NAS100", "futures", undefined) === null);

  // WTI: the proxy and Stooq are both the front-month future; FRED's series is
  // the Cushing spot price, which is close but is not the same instrument.
  check("WTI's FRED fallback is announced as spot",
    basisNote("WTI", "futures", "fred")?.includes("現貨") === true);
  check("but its Stooq ticker is the same future, so it is silent",
    basisNote("WTI", "futures", "stooq") === null);
}

report("期貨與現貨");

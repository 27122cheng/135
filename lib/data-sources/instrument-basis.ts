import type { SupportedSymbol } from "@/types/signal";

/**
 * 期貨還是現貨 —— 同一個名字，不同的商品。
 *
 * ## The bug this exists to stop
 *
 * A user compared the site against their broker on gold: we said 4,448.00,
 * the broker's spot quote said 4,391.62, and the broker's high for the day was
 * 4,436.05. Our number was above a price that never traded — because it was
 * not the same instrument. `XAUUSD` was mapped to `GC=F`, the COMEX futures
 * contract, which carries a financing premium over spot (1.28% that day).
 *
 * Worse, the fallbacks disagreed with the primary *and with each other*: Stooq,
 * Twelve Data and gold-api all serve spot, FMP's GCUSD serves futures. So
 * "every price is different" was exactly right, and which one you saw depended
 * on which source happened to answer first. Levels built on one and compared
 * against the other are wrong by the basis, silently, forever.
 *
 * ## The rule
 *
 * Every symbol declares the basis it is *about*, and every source declares the
 * basis it *returns*. Gold is now spot end to end — the instrument people
 * actually trade. The three index CFDs stay on futures, deliberately: the cash
 * indices only print during their exchange session, and using them was what
 * made US30 read 休市中 through every pre-market. But their keyless fallbacks
 * are cash, and when one of those supplies the price the difference is stated
 * rather than absorbed.
 *
 * A basis note is not a failure — the price is still the best available and is
 * still used. It is a fact the reader needs before comparing the number against
 * a broker screen.
 */

export type Basis = "spot" | "futures" | "cash-index";

const BASIS_LABEL: Record<Basis, string> = {
  spot: "現貨",
  futures: "期貨",
  "cash-index": "現貨指數",
};

/** What each quote source actually returns, per symbol. Absent = same as the symbol's own. */
const SOURCE_BASIS: Partial<Record<SupportedSymbol, Partial<Record<string, Basis>>>> = {
  // The three index CFDs track futures; every keyless fallback is the cash index.
  NAS100: { stooq: "cash-index", twelvedata: "cash-index", fmp: "cash-index", fred: "cash-index" },
  US30: { stooq: "cash-index", twelvedata: "cash-index", fmp: "cash-index", fred: "cash-index" },
  SPX500: { stooq: "cash-index", twelvedata: "cash-index", fmp: "cash-index", fred: "cash-index" },
  // WTI is futures on the proxy and on Stooq; FRED's series is the Cushing
  // spot price, which tracks the front month closely but is not it.
  WTI: { fred: "spot" },
};

/**
 * The note to attach when the answering source is not quoting the instrument
 * the symbol is about. Null when they agree — which must be the common case,
 * or the mapping is wrong rather than the market.
 */
export function basisNote(
  symbol: string,
  symbolBasis: Basis,
  source: string | undefined,
): string | null {
  if (!source) return null;
  const actual = SOURCE_BASIS[symbol as SupportedSymbol]?.[source];
  if (!actual || actual === symbolBasis) return null;
  return (
    `本次價格來自 ${source}，報的是${BASIS_LABEL[actual]}，` +
    `而本商品的分析基準是${BASIS_LABEL[symbolBasis]} —— 兩者之間有基差，` +
    `與券商報價比對時會有落差，價位仍以此為準計算。`
  );
}

/** For the card: which instrument the numbers on it describe. */
export function basisLabel(basis: Basis): string {
  return BASIS_LABEL[basis];
}

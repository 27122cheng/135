import { COMMODITIES, type CommodityMeta } from "@/types/signal";

/**
 * 這個代號屬於哪一類 —— for the synchronous callers that only have a symbol id.
 *
 * Trading costs are per category (config/trading-costs.ts), and two hot paths
 * resolve them from a bare symbol string inside pure, synchronous functions:
 * the plan backtest and the forward ledger's R reconstruction. Both did their
 * own `COMMODITIES.find(...)`, which for a user-added symbol returns
 * undefined — and the fallbacks were silently wrong in opposite directions:
 * the backtest charged crypto an *index* spread, and the ledger charged a
 * custom symbol **zero cost**, so every BTC/ETH forward trade's R was
 * measured on a strategy nobody can trade.
 *
 * A synchronous answer cannot consult app_settings (that read is async), so
 * this resolves what it can and states the rest:
 *
 *  - a built-in answers from its own row;
 *  - a crypto id is recognised by shape, because that is the one custom
 *    category whose costs differ from the fallback by an order of magnitude
 *    and the ids are unambiguous (BTCUSD, ETHUSDT, SOL-USD);
 *  - anything else falls back, and the fallback is a *cost*, never free.
 *
 * Callers that already hold the meta should pass its category instead of
 * guessing here — `categoryOf` exists for the ones that genuinely cannot.
 */

export type TradingCategory = CommodityMeta["category"];

/**
 * Crypto by the shape of the id. Deliberately narrower than the data-source
 * detectors (which accept Yahoo's BASE-USD form): this one also has to
 * recognise the *internal* id a user typed on /symbols, e.g. "BTCUSD".
 *
 * The `(?!EUR|GBP|AUD|NZD|USD|CHF|CAD|JPY)` guard is what keeps EURUSD and
 * GBPUSD out — they end in USD too, and mislabelling a major as crypto would
 * charge it a 0.2% round trip it never pays.
 */
const CRYPTO_ID =
  /^(?!(?:EUR|GBP|AUD|NZD|USD|CHF|CAD|JPY|XAU|XAG)USD)[A-Z0-9]{2,10}[-]?USD[TC]?$/i;

export function isCryptoSymbolId(symbol: string): boolean {
  return CRYPTO_ID.test(symbol.trim());
}

export function categoryOf(
  symbol: string | undefined | null,
  fallback: TradingCategory = "index",
): TradingCategory {
  if (!symbol) return fallback;
  const builtin = COMMODITIES.find((c) => c.symbol === symbol);
  if (builtin) return builtin.category;
  if (isCryptoSymbolId(symbol)) return "crypto";
  return fallback;
}

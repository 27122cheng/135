import type { CommodityMeta, SupportedSymbol } from "@/types/signal";
import { fetchFree } from "./free-source";
import { fetchJson } from "./http";
import type { LatestPrice } from "./yfinance";

/**
 * TradingView — the fifth live quote witness, keyless.
 *
 * ## What this is and is not
 *
 * TradingView's *chart history* rides a private websocket protocol: no REST,
 * session handshakes, and a shape that changes without notice — unusable from
 * a serverless function that lives for sixty seconds. What they do expose
 * over plain HTTPS is the scanner's quote endpoint, which answers with the
 * last price and its print time for any symbol their charts can show. So
 * this file is a quote source only; candles keep their six-leg chain
 * (proxy, Finnhub, Stooq, Twelve Data, FMP, Binance).
 *
 * ## Why OANDA symbols
 *
 * Scanner symbols are exchange-prefixed, and one broker namespace covers all
 * nine instruments with the *right basis*: OANDA's XAUUSD is spot (the
 * symbol's declared basis), its index CFDs track the futures the index
 * symbols declare, and WTICOUSD tracks the front month. One namespace, no
 * basis notes, no per-symbol special cases.
 *
 * Unofficial endpoint, stated plainly: it can change shape or disappear.
 * Every answer is validated field-by-field and an unexpected shape is a
 * reported failure, never a guessed price — the same contract as the vendors
 * that answer HTTP 200 with error bodies.
 */

const TV_SYMBOL: Partial<Record<SupportedSymbol, string>> = {
  EURUSD: "OANDA:EURUSD",
  USDJPY: "OANDA:USDJPY",
  GBPUSD: "OANDA:GBPUSD",
  XAUUSD: "OANDA:XAUUSD",
  WTI: "OANDA:WTICOUSD",
  NAS100: "OANDA:NAS100USD",
  US30: "OANDA:US30USD",
  SPX500: "OANDA:SPX500USD",
  GER40: "OANDA:DE30EUR",
};

export function tradingViewSymbol(symbol: string): string | null {
  return TV_SYMBOL[symbol as SupportedSymbol] ?? null;
}

/** `lp` = last price, `lp_time` = its Unix print time. Anything else is noise. */
interface ScannerQuote {
  lp?: number;
  lp_time?: number;
}

/** POST scan response: one row per requested ticker, columns in order. */
interface ScanResponse {
  data?: Array<{ s?: string; d?: unknown[] }>;
}

/** Validates a (price, time) pair into the quote shape, or null. */
function asQuote(price: unknown, at: unknown): { price: number; at: string } | null {
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return null;
  // No timestamp, no quote — an unstamped price would win every freshness
  // contest by construction, the exact failure the freshness rule catches.
  if (typeof at !== "number" || !(at > 0)) return null;
  return { price, at: new Date(at * 1000).toISOString() };
}

export async function fetchTradingViewQuote(
  meta: Pick<CommodityMeta, "symbol">,
  gaps: string[],
): Promise<LatestPrice | null> {
  const ticker = tradingViewSymbol(meta.symbol);
  if (!ticker) return null;

  const result = await fetchFree<{ price: number; at: string }>({
    source: "tradingview",
    label: `TradingView 報價 (${ticker})`,
    key: `tradingview:quote:${ticker}`,
    ttlMs: 2 * 60 * 1000,
    // A stale quote is worse than none for position management.
    staleMs: 10 * 60 * 1000,
    // Self-imposed: the endpoint publishes no limit, and an unofficial one
    // deserves gentler treatment than a documented one, not rougher.
    limit: { perMinute: 20 },
    gaps,
    fn: async () => {
      // The POST scan is the request TradingView's own screener pages make,
      // which makes it the *least* likely of the unofficial surfaces to
      // drift — the GET /symbol shortcut this used first went shape-dark in
      // production (「未回傳有效價格」 on every call) while the site itself
      // kept quoting, i.e. the scan kept working. Row shape:
      // {data:[{s:"OANDA:XAUUSD", d:[lp, lp_time]}]}.
      const scanned = await fetchJson<ScanResponse>(
        "https://scanner.tradingview.com/global/scan",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            symbols: { tickers: [ticker] },
            columns: ["lp", "lp_time"],
          }),
        },
        7000,
      );
      const row = scanned?.data?.find((r) => r.s === ticker) ?? scanned?.data?.[0];
      const fromScan = row && Array.isArray(row.d) ? asQuote(row.d[0], row.d[1]) : null;
      if (fromScan) return fromScan;

      // Old GET surface as the backup, same validation.
      const data = await fetchJson<ScannerQuote>(
        `https://scanner.tradingview.com/symbol?symbol=${encodeURIComponent(ticker)}` +
          `&fields=lp,lp_time&no_404=true`,
        undefined,
        7000,
      );
      const fromGet = data && typeof data === "object" ? asQuote(data.lp, data.lp_time) : null;
      if (!fromGet) {
        gaps.push(`TradingView (${ticker}) 未回傳有效價格（scan 與 symbol 兩端點皆然，端點無金鑰且非官方）`);
        return null;
      }
      return fromGet;
    },
  });

  if (!result) return null;
  return {
    price: result.value.price,
    at: result.value.at,
    ageMinutes: Math.max(0, (Date.now() - new Date(result.value.at).getTime()) / 60000),
    source: "tradingview",
  };
}

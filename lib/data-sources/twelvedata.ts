import { getKey } from "../api-keys";
import type { CommodityMeta, SupportedSymbol } from "@/types/signal";
import { fetchFree } from "./free-source";
import { fetchJson } from "./http";
import type { LatestPrice } from "./yfinance";

/**
 * Twelve Data — a fourth quote source, and the only *live* one that is neither
 * Yahoo nor Stooq.
 *
 * ## Why another one
 *
 * The live chain was two companies deep: Yahoo's chart endpoint, then Stooq's
 * quote CSV. Everything after those is end-of-day — FRED's official closes,
 * ER-API's daily FX fix, gold-api's spot. That is a real gap: when both live
 * feeds go dark mid-session (and Yahoo has frozen this deployment's data for
 * days at a time), the best remaining answer is yesterday's close, and the
 * board goes to 休市中 on markets that are trading.
 *
 * Twelve Data is a proper market-data vendor rather than a scraped endpoint,
 * covers all nine instruments including GER40 (which has no keyless third
 * witness at all — FRED's DAX series is discontinued), and its free tier is
 * 800 requests a day. Nine symbols on the 4-hourly sweep is 54, and the
 * 5-minute monitor reads a cached quote, so the ceiling is not the binding
 * constraint.
 *
 * ## Why it is optional
 *
 * It needs a key. Every other source in this file's neighbourhood is keyless
 * on purpose, and the deployment must keep working for someone who has not
 * pasted one — so this returns null without a key, quietly, and the chain
 * behaves exactly as it did before. The key is user-settable on the settings
 * page like the others; nothing here needs a redeploy.
 *
 * ## Coverage is verified by the response, not assumed
 *
 * Free tiers gate instrument classes and change the gating without notice —
 * Finnhub's free plan serves US equities and 403s on forex candles, which is
 * why this codebase stopped asking it for them. Rather than encode a guess
 * about which of forex/indices/commodities Twelve Data's free plan covers
 * today, every symbol is asked and a plan-limit answer is reported as a gap
 * and falls through. The vendor's own error message is the documentation.
 */

/** Twelve Data's ticker for each instrument. Null where nothing maps cleanly. */
const TD_SYMBOL: Partial<Record<SupportedSymbol, string>> = {
  EURUSD: "EUR/USD",
  USDJPY: "USD/JPY",
  GBPUSD: "GBP/USD",
  XAUUSD: "XAU/USD",
  WTI: "WTI/USD",
  NAS100: "NDX",
  US30: "DJI",
  SPX500: "SPX",
  GER40: "GDAXI",
};

export function twelveDataSymbol(symbol: string): string | null {
  return TD_SYMBOL[symbol as SupportedSymbol] ?? null;
}

interface QuoteResponse {
  symbol?: string;
  close?: string | number;
  /** Unix seconds of the last print. */
  timestamp?: number;
  datetime?: string;
  is_market_open?: boolean;
  /** Error shape: `{ code, message, status: "error" }`. */
  status?: string;
  code?: number;
  message?: string;
}

function numeric(v: string | number | undefined): number | null {
  if (v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The instrument's last traded price, or null.
 *
 * Never throws and never invents: a missing key, an unmapped symbol, a plan
 * limit or a malformed answer all return null so the caller's freshness
 * contest simply proceeds with one fewer witness.
 */
export async function fetchTwelveDataQuote(
  meta: Pick<CommodityMeta, "symbol">,
  gaps: string[],
): Promise<LatestPrice | null> {
  const apiKey = getKey("TWELVEDATA_API_KEY");
  if (!apiKey) return null;
  const ticker = twelveDataSymbol(meta.symbol);
  if (!ticker) return null;

  const result = await fetchFree<{ price: number; at: string }>({
    source: "twelvedata",
    label: `Twelve Data 即時報價 (${ticker})`,
    key: `twelvedata:quote:${ticker}`,
    // The same two minutes the other live quote uses — the monitor runs every
    // five, and a quote cached longer than the loop that reads it is a quote
    // that will always be one cycle behind.
    ttlMs: 2 * 60 * 1000,
    // A stale quote is worse than none for position management.
    staleMs: 10 * 60 * 1000,
    // Free tier: 8 requests/minute, 800/day. Stated conservatively — going over
    // returns a 429 that costs the call anyway.
    limit: { perMinute: 8, perDay: 800 },
    gaps,
    fn: async () => {
      const data = await fetchJson<QuoteResponse>(
        `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(ticker)}&apikey=${encodeURIComponent(apiKey)}`,
        undefined,
        12000,
      );
      if (!data) return null;
      // The vendor answers 200 with an error body, so a plan limit or a bad
      // key looks like success to the transport layer. Say which it was.
      if (data.status === "error" || data.code !== undefined) {
        gaps.push(
          `Twelve Data (${ticker}) 未回傳報價：${data.message ?? `代碼 ${data.code}`}` +
            (String(data.message ?? "").match(/plan|upgrade|not available/i)
              ? "（免費方案不含此商品類別，其他來源仍照常運作）"
              : ""),
        );
        return null;
      }
      const price = numeric(data.close);
      if (price === null) return null;
      // `timestamp` is when the print happened. Falling back to `datetime`
      // rather than to now(): a quote that stamps itself with the current
      // clock would win every freshness contest by construction, which is
      // exactly the failure the freshness rule exists to catch.
      const at =
        typeof data.timestamp === "number" && data.timestamp > 0
          ? new Date(data.timestamp * 1000).toISOString()
          : data.datetime
            ? new Date(`${data.datetime.replace(" ", "T")}Z`).toISOString()
            : null;
      if (at === null || Number.isNaN(new Date(at).getTime())) return null;
      return { price, at };
    },
  });

  if (!result) return null;
  return {
    price: result.value.price,
    at: result.value.at,
    ageMinutes: Math.max(0, (Date.now() - new Date(result.value.at).getTime()) / 60000),
    source: "twelvedata",
  };
}

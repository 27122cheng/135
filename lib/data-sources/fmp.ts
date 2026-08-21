import { getKey } from "../api-keys";
import type { CommodityMeta, SupportedSymbol, Timeframe } from "@/types/signal";
import { CANDLE_STALE_MS } from "./cache";
import { fetchFree } from "./free-source";
import { fetchJson } from "./http";
import type { Candle, LatestPrice } from "./yfinance";

/**
 * Financial Modeling Prep — the fourth quote witness.
 *
 * Twelve Data closed the "only two live companies" gap; this closes the one
 * after it. Two independent vendors both being down at once is unlikely;
 * two being down *and* both keyless scrapes being frozen is the situation
 * that produced a day and a half of 休市中, and each additional company
 * multiplies the odds of that rather than adding to them.
 *
 * Smaller free allowance than Twelve Data (~250 requests a day against 800),
 * which is why it sits behind it in the chain rather than beside it: it is
 * asked only when everything above has already failed to produce a fresh
 * price. At that point 250 a day is plenty — that path is not supposed to be
 * the common one.
 *
 * Same contract as every other optional source here: no key, no call, no gap,
 * and the chain behaves exactly as it did before.
 */

/** FMP's ticker per instrument. Forex is bare, commodities take a USD suffix. */
const FMP_SYMBOL: Partial<Record<SupportedSymbol, string>> = {
  EURUSD: "EURUSD",
  USDJPY: "USDJPY",
  GBPUSD: "GBPUSD",
  // Spot, matching the symbol's declared basis — GCUSD is the futures contract.
  XAUUSD: "XAUUSD",
  WTI: "CLUSD",
  NAS100: "^NDX",
  US30: "^DJI",
  SPX500: "^GSPC",
  GER40: "^GDAXI",
};

export function fmpSymbol(symbol: string): string | null {
  return FMP_SYMBOL[symbol as SupportedSymbol] ?? null;
}

interface FmpQuote {
  symbol?: string;
  price?: number;
  /** Unix seconds of the last print. */
  timestamp?: number;
}

/** The error shape: a bare object with a message, not an array. */
interface FmpError {
  "Error Message"?: string;
  message?: string;
}

export async function fetchFmpQuote(
  meta: Pick<CommodityMeta, "symbol">,
  gaps: string[],
): Promise<LatestPrice | null> {
  const apiKey = getKey("FMP_API_KEY");
  if (!apiKey) return null;
  const ticker = fmpSymbol(meta.symbol);
  if (!ticker) return null;

  const result = await fetchFree<{ price: number; at: string }>({
    source: "fmp",
    label: `FMP 即時報價 (${ticker})`,
    key: `fmp:quote:${ticker}`,
    ttlMs: 2 * 60 * 1000,
    staleMs: 10 * 60 * 1000,
    // Free tier: 250 requests a day. Stated conservatively — this is the last
    // live witness, and exhausting it on a quiet day defeats the purpose.
    limit: { perMinute: 10, perDay: 250 },
    gaps,
    fn: async () => {
      const data = await fetchJson<FmpQuote[] | FmpError>(
        `https://financialmodelingprep.com/api/v3/quote/${encodeURIComponent(ticker)}?apikey=${encodeURIComponent(apiKey)}`,
        undefined,
        // Short on purpose — see twelvedata.ts.
        7000,
      );
      if (!data) return null;
      // Like Twelve Data, the vendor answers HTTP 200 with an error object for
      // a bad key or a plan limit — an array is the only shape that means
      // success, so anything else is reported rather than parsed hopefully.
      if (!Array.isArray(data)) {
        const message = data["Error Message"] ?? data.message ?? "未知錯誤";
        gaps.push(
          `FMP (${ticker}) 未回傳報價：${message}` +
            (/plan|subscription|exclusive|upgrade/i.test(message)
              ? "（免費方案不含此商品，其他來源仍照常運作）"
              : ""),
        );
        return null;
      }
      const quote = data[0];
      const price = quote?.price;
      if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return null;
      // No timestamp, no quote. A price stamped with the current clock would
      // win every freshness contest by construction — the exact failure the
      // freshness rule exists to catch.
      if (typeof quote.timestamp !== "number" || quote.timestamp <= 0) return null;
      return { price, at: new Date(quote.timestamp * 1000).toISOString() };
    },
  });

  if (!result) return null;
  return {
    price: result.value.price,
    at: result.value.at,
    ageMinutes: Math.max(0, (Date.now() - new Date(result.value.at).getTime()) / 60000),
    source: "fmp",
  };
}

interface FmpDailyRow {
  date?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
}

/**
 * OHLCV from FMP — the candle chain's fifth and last leg.
 *
 * Daily comes from `historical-price-full` (an object wrapping a newest-first
 * `historical` array), 4-hour from `historical-chart/4hour` (a bare
 * newest-first array reaching back a few weeks — enough for the live H4 read,
 * not for the lab). There is no weekly endpoint on the free plan, so W1
 * returns null without spending a request — the caller's chain simply moves
 * on. Sits behind Twelve Data for the same reason the quote does: the
 * smaller daily allowance belongs on the rarest path.
 */
export async function fetchFmpOHLCV(
  meta: Pick<CommodityMeta, "symbol">,
  timeframe: Timeframe,
  gaps: string[],
  opts: { ttlMs: number },
): Promise<Candle[] | null> {
  if (timeframe === "W1") return null;
  const apiKey = getKey("FMP_API_KEY");
  if (!apiKey) return null;
  const ticker = fmpSymbol(meta.symbol);
  if (!ticker) return null;

  const result = await fetchFree<Candle[]>({
    source: "fmp",
    label: `FMP K 棒 (${ticker} ${timeframe})`,
    key: `fmp:series:${ticker}:${timeframe}`,
    ttlMs: opts.ttlMs,
    staleMs: CANDLE_STALE_MS,
    limit: { perMinute: 10, perDay: 250 },
    gaps,
    fn: async () => {
      const url =
        timeframe === "D1"
          ? `https://financialmodelingprep.com/api/v3/historical-price-full/${encodeURIComponent(ticker)}?timeseries=400&apikey=${encodeURIComponent(apiKey)}`
          : `https://financialmodelingprep.com/api/v3/historical-chart/4hour/${encodeURIComponent(ticker)}?apikey=${encodeURIComponent(apiKey)}`;
      const data = await fetchJson<
        FmpDailyRow[] | { historical?: FmpDailyRow[] } | FmpError
      >(url, undefined, 7000);
      if (!data) return null;

      // Success is an array (4hour) or an object with a `historical` array
      // (daily). Anything else is the vendor's HTTP-200 error body.
      const rows = Array.isArray(data)
        ? data
        : Array.isArray((data as { historical?: FmpDailyRow[] }).historical)
          ? (data as { historical: FmpDailyRow[] }).historical
          : null;
      if (!rows) {
        const err = data as FmpError;
        const message = err["Error Message"] ?? err.message ?? "未知錯誤";
        gaps.push(
          `FMP (${ticker} ${timeframe}) 未回傳 K 棒：${message}` +
            (/plan|subscription|exclusive|upgrade/i.test(message)
              ? "（免費方案不含此商品，其他來源仍照常運作）"
              : ""),
        );
        return null;
      }

      // Newest-first from the vendor; consumers walk oldest-first.
      const candles: Candle[] = [];
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        if (!r.date) continue;
        const iso = r.date.includes(" ")
          ? new Date(`${r.date.replace(" ", "T")}Z`).toISOString()
          : new Date(`${r.date}T00:00:00Z`).toISOString();
        if (Number.isNaN(new Date(iso).getTime())) continue;
        if (![r.open, r.high, r.low, r.close].every((n) => typeof n === "number" && Number.isFinite(n))) {
          continue;
        }
        candles.push({
          time: iso,
          open: r.open!,
          high: r.high!,
          low: r.low!,
          close: r.close!,
          volume:
            typeof r.volume === "number" && Number.isFinite(r.volume) && r.volume > 0
              ? r.volume
              : null,
        });
      }
      return candles.length > 0 ? candles : null;
    },
  });

  return result?.value ?? null;
}

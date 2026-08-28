import { getKey } from "../api-keys";
import type { CommodityMeta, Timeframe } from "@/types/signal";
import { fetchBinanceOHLCV } from "./binance-crypto";
import { fetchKrakenOHLCV } from "./kraken-crypto";
import { CANDLE_STALE_MS } from "./cache";
import { fetchFmpOHLCV } from "./fmp";
import { fetchFree } from "./free-source";
import { fetchJson } from "./http";
import { fetchStooqText } from "./stooq-fetch";
import { fetchTwelveDataOHLCV } from "./twelvedata";
import { fetchViaProxy, OHLCV_TTL_MS, type Candle } from "./yfinance";

export type { Candle } from "./yfinance";

export interface OHLCVResult {
  symbol: string;
  timeframe: Timeframe;
  candles: Candle[];
  source: "yfinance-proxy" | "finnhub" | "stooq" | "twelvedata" | "fmp" | "binance" | "kraken";
  /** True when the candles came from cache past its TTL. Never hidden from the user. */
  stale: boolean;
}

/**
 * Finnhub's free tier, kept as the spec's named fallback.
 *
 * In practice it is skipped for all nine built-ins: `finnhubSymbol` is null for
 * them because Finnhub gates candles for forex, commodities and indices behind
 * a paid plan, and spending a round-trip to collect a 403 helps nobody. It does
 * serve US equities on the free tier, so a user-added stock can use this path.
 */
async function fetchFinnhubOHLCV(
  meta: CommodityMeta,
  timeframe: Timeframe,
  gaps: string[],
): Promise<OHLCVResult | null> {
  const ticker = meta.finnhubSymbol;
  if (!ticker) return null;
  const apiKey = getKey("FINNHUB_API_KEY");
  if (!apiKey) return null;

  const resolution = { H4: "60", D1: "D", W1: "W" }[timeframe];
  // H4 is assembled from 1h bars, as with the proxy — Finnhub has no 4h resolution.
  const now = Math.floor(Date.now() / 1000);
  const lookbackSec = timeframe === "W1" ? 5 * 365 * 86400 : timeframe === "D1" ? 400 * 86400 : 90 * 86400;

  const result = await fetchFree<Candle[]>({
    source: "finnhub",
    label: `Finnhub OHLCV (${ticker} ${timeframe})`,
    key: `finnhub:candle:${ticker}:${resolution}`,
    ttlMs: OHLCV_TTL_MS,
    staleMs: CANDLE_STALE_MS,
    // Documented free tier: 60 req/min.
    limit: { perMinute: 60 },
    gaps,
    fn: async () => {
      const url =
        `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(ticker)}` +
        `&resolution=${resolution}&from=${now - lookbackSec}&to=${now}&token=${apiKey}`;
      const data = await fetchJson<{
        s?: string;
        t?: number[];
        o?: number[];
        h?: number[];
        l?: number[];
        c?: number[];
        v?: number[];
      }>(url, undefined, 12000);
      if (!data || data.s !== "ok" || !Array.isArray(data.t)) return null;
      const candles: Candle[] = data.t
        .map((t, i) => ({
          time: new Date(t * 1000).toISOString(),
          open: data.o?.[i] ?? NaN,
          high: data.h?.[i] ?? NaN,
          low: data.l?.[i] ?? NaN,
          close: data.c?.[i] ?? NaN,
          volume: data.v?.[i] ?? null,
        }))
        .filter((c) => [c.open, c.high, c.low, c.close].every((n) => Number.isFinite(n)));
      return candles.length > 0 ? candles : null;
    },
  });

  if (!result) return null;
  return {
    symbol: meta.symbol,
    timeframe,
    candles: result.value,
    source: "finnhub",
    stale: result.stale,
  };
}

const STOOQ_INTERVAL: Partial<Record<Timeframe, string>> = { D1: "d", W1: "w" };

/**
 * Stooq's CSV download — keyless, daily/weekly only, no account of any kind.
 * Last resort when the proxy is unavailable (Yahoo does sometimes refuse
 * datacenter IPs). The tickers in CommodityMeta.stooqSymbol could not be
 * verified live from the build sandbox, so a wrong one yields no rows and
 * falls through rather than producing wrong candles.
 */
async function fetchStooqOHLCV(
  meta: CommodityMeta,
  timeframe: Timeframe,
  gaps: string[],
): Promise<OHLCVResult | null> {
  const interval = STOOQ_INTERVAL[timeframe];
  if (!interval) return null;

  const result = await fetchFree<Candle[]>({
    source: "stooq",
    label: `Stooq (${meta.stooqSymbol} ${timeframe})`,
    key: `stooq:${meta.stooqSymbol}:${timeframe}`,
    ttlMs: OHLCV_TTL_MS,
    staleMs: CANDLE_STALE_MS,
    // Self-imposed: Stooq publishes no limit for the CSV download.
    limit: { perMinute: 30, perDay: 1000 },
    gaps,
    fn: async () => {
      const csv = await fetchStooqText(
        `/q/d/l/?s=${encodeURIComponent(meta.stooqSymbol)}&i=${interval}`,
      );
      if (!csv) return null;
      const candles: Candle[] = [];
      for (const line of csv.trim().split(/\r?\n/).slice(1)) {
        const [date, open, high, low, close, volume] = line.split(",");
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        const parsed = {
          time: new Date(`${date}T00:00:00Z`).toISOString(),
          open: Number(open),
          high: Number(high),
          low: Number(low),
          close: Number(close),
          volume: volume ? Number(volume) : null,
        };
        if ([parsed.open, parsed.high, parsed.low, parsed.close].every((n) => Number.isFinite(n))) {
          candles.push(parsed);
        }
      }
      return candles.length > 0 ? candles : null;
    },
  });

  if (!result) return null;
  return {
    symbol: meta.symbol,
    timeframe,
    candles: result.value,
    source: "stooq",
    stale: result.stale,
  };
}

/**
 * Source chain: our own yfinance proxy, then Finnhub, then Stooq's CSV. Each
 * link tracks its own quota and backs off on failure; each can answer with a
 * stale-but-real cached copy. Never fabricates candles — if all three have
 * nothing, the caller gets null and a data_gap, and the signal degrades.
 *
 * Individual failures are collected into `attempts` and only surfaced if every
 * source fails, so a working fallback doesn't report a gap that cost nothing.
 * Stale notices are the exception: they go straight to `gaps`, because data
 * being three hours old is a fact the user needs whether or not a later source
 * would have worked.
 */
export async function fetchOHLCV(
  meta: CommodityMeta,
  timeframe: Timeframe,
  gaps: string[],
): Promise<OHLCVResult | null> {
  // Each source writes into its own buffer rather than straight into `gaps`.
  // Without this, the proxy failing would report a gap even when Stooq goes on
  // to answer — nagging about a fallback that cost the user nothing.
  const attempts: string[] = [];

  /**
   * Promotes a finished source's messages. On success only the stale notice
   * survives: "this data is three hours old" is a fact the user needs whether
   * or not a later source would have worked, while "source A was down" is not.
   */
  const promoteStale = (buffer: string[]) => {
    for (const message of buffer) {
      if (message.includes("stale")) gaps.push(message);
    }
  };

  // Crypto trades on the exchange whose keyless API we can ask directly —
  // routing BTCUSD through Yahoo's delayed mirror while Binance sits unused
  // is how a 24/7 instrument reported "K 棒不足". The venue answers first;
  // the ordinary chain below remains the fallback.
  if (meta.category === "crypto") {
    const binanceGaps: string[] = [];
    const binance = await fetchBinanceOHLCV(meta, timeframe, binanceGaps, {
      ttlMs: OHLCV_TTL_MS,
    });
    if (binance) {
      promoteStale(binanceGaps);
      return { symbol: meta.symbol, timeframe, candles: binance, source: "binance", stale: false };
    }
    attempts.push(...binanceGaps, "Binance 無回應（美國機房 IP 會被 451 地區封鎖——部署在 Vercel 時屬預期）");
    // Second venue: Kraken serves the US region Binance refuses, keyless,
    // native 4h/1d/1w, real USD books. This is the leg that makes crypto
    // data actually exist in production.
    const krakenGaps: string[] = [];
    const kraken = await fetchKrakenOHLCV(meta, timeframe, krakenGaps, {
      ttlMs: OHLCV_TTL_MS,
    });
    if (kraken) {
      promoteStale(krakenGaps);
      return { symbol: meta.symbol, timeframe, candles: kraken, source: "kraken", stale: false };
    }
    attempts.push(...krakenGaps, "Kraken 無回應");
  }

  const proxyGaps: string[] = [];
  const proxied = await fetchViaProxy(meta.yfinanceSymbol, timeframe, proxyGaps);
  // A 200 with frozen bars is a failure wearing a success's clothes. Yahoo
  // served this deployment data stuck at the previous Thursday — for days —
  // and because the fetch "succeeded", the fallback chain never ran and Stooq
  // sat unused while every card said 休市中. Four days covers any weekend plus
  // slack; bars older than that mid-chain are grounds to try the next source,
  // not something to present as the market.
  const FROZEN_AFTER_MS = 4 * 24 * 60 * 60 * 1000;
  const newest = proxied?.candles.at(-1)?.time;
  const frozen =
    newest !== undefined && Date.now() - new Date(newest).getTime() > FROZEN_AFTER_MS;
  if (proxied && !frozen) {
    promoteStale(proxyGaps);
    return {
      symbol: meta.symbol,
      timeframe,
      candles: proxied.candles,
      source: "yfinance-proxy",
      stale: proxied.stale,
    };
  }
  attempts.push(
    ...proxyGaps,
    frozen
      ? `行情代理回應的 K 棒停在 ${String(newest).slice(0, 10)}（疑似上游凍結），視為失敗改試下一個來源`
      : "行情代理無回應",
  );

  const finnhubGaps: string[] = [];
  const finnhub = await fetchFinnhubOHLCV(meta, timeframe, finnhubGaps);
  if (finnhub) {
    promoteStale(finnhubGaps);
    return finnhub;
  }
  attempts.push(
    ...finnhubGaps,
    meta.finnhubSymbol ? "Finnhub 無回應" : "Finnhub 不支援此標的（免費層無此類 K 線）",
  );

  const stooqGaps: string[] = [];
  const stooq = await fetchStooqOHLCV(meta, timeframe, stooqGaps);
  if (stooq) {
    promoteStale(stooqGaps);
    return stooq;
  }
  attempts.push(
    ...stooqGaps,
    STOOQ_INTERVAL[timeframe] ? "Stooq 無回應" : `Stooq 不支援 ${timeframe}`,
  );

  // Two keyed vendors close the chain — the same pair that already witnesses
  // quotes. Twelve Data first (larger allowance, and the only fallback with
  // native 4h bars); FMP last, W1 excluded on its free plan. Both skip
  // silently without a key, so an unconfigured deployment behaves as before.
  const tdGaps: string[] = [];
  const td = await fetchTwelveDataOHLCV(meta, timeframe, tdGaps, {
    outputsize: timeframe === "H4" ? 500 : 400,
    ttlMs: OHLCV_TTL_MS,
  });
  if (td) {
    promoteStale(tdGaps);
    return { symbol: meta.symbol, timeframe, candles: td, source: "twelvedata", stale: false };
  }
  attempts.push(...tdGaps);

  const fmpGaps: string[] = [];
  const fmp = await fetchFmpOHLCV(meta, timeframe, fmpGaps, { ttlMs: OHLCV_TTL_MS });
  if (fmp) {
    promoteStale(fmpGaps);
    return { symbol: meta.symbol, timeframe, candles: fmp, source: "fmp", stale: false };
  }
  attempts.push(...fmpGaps);

  // The frozen proxy answer is still the last resort: rejecting it existed to
  // let a *better* source answer, and none did. An 11-day-old series labelled
  // as such beats an empty chart — the same rule the stale cache tier follows.
  if (proxied && frozen) {
    gaps.push(
      `${meta.symbol} ${timeframe} 僅剩行情代理的舊資料可用（最新 K 棒 ${String(newest).slice(0, 10)}，其他來源皆失敗），資料非即時`,
    );
    return {
      symbol: meta.symbol,
      timeframe,
      candles: proxied.candles,
      source: "yfinance-proxy",
      stale: true,
    };
  }

  gaps.push(`${meta.symbol} ${timeframe} OHLCV 所有來源皆失敗（${attempts.join("；")}）`);
  return null;
}

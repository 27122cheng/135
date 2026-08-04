import type { Timeframe } from "@/types/signal";
import { fetchFree } from "./free-source";
import { fetchJson } from "./http";

/**
 * The self-hosted yfinance proxy's engine.
 *
 * "Self-hosted proxy" rather than a vendor API because every hosted quote
 * service that covers FX + indices + commodities at once is now paid: Twelve
 * Data's free plan only opens 3 markets, Alpha Vantage's is down to ~25
 * requests a day. The Yahoo chart endpoint that the `yfinance` library wraps
 * covers all nine tickers for free — so we call it from our own server, cache
 * it for 30 minutes, and spend a self-imposed budget against it.
 *
 * Two consequences worth being explicit about:
 *  - This is an undocumented endpoint with no SLA. It can change shape or
 *    start refusing datacenter IPs without notice, which is why ohlcv.ts keeps
 *    real fallbacks rather than treating this as the only source.
 *  - The data is end-of-day or ~15 minutes delayed. That is accepted (the
 *    smallest timeframe here is H4), but it must never be presented as live.
 *
 * app/api/proxy/ohlcv/route.ts is the HTTP surface over this module; server
 * code calls the function directly instead of making a round-trip to itself.
 */

export interface Candle {
  time: string; // ISO 8601
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

/** 30 minutes, per spec — the free tier is delayed anyway, so a fresher cache buys nothing. */
export const OHLCV_TTL_MS = 30 * 60 * 1000;

/**
 * Self-imposed, not published: Yahoo documents no limit for this endpoint, so
 * these numbers exist to keep us from looking like a scraper. A full refresh
 * of 9 symbols × 3 timeframes is 27 calls, well inside them.
 */
const YAHOO_LIMIT = { perMinute: 60, perDay: 2000 };

/**
 * H4 has no native Yahoo interval, so it is built by resampling real 1h
 * candles — never by interpolating. 3mo of hourly data yields ~385 4h bars,
 * more than the 260 the analysis asks for.
 */
const INTERVALS: Record<Timeframe, { interval: string; range: string }> = {
  H4: { interval: "60m", range: "3mo" },
  D1: { interval: "1d", range: "1y" },
  W1: { interval: "1wk", range: "5y" },
};

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      meta?: { regularMarketTime?: number; exchangeTimezoneName?: string };
      indicators?: {
        quote?: Array<{
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }>;
      };
    }>;
    error?: { description?: string };
  };
}

/** Groups chronologically-ordered hourly candles into 4h buckets aligned to UTC 0/4/8/12/16/20. */
export function resampleTo4h(hourly: Candle[]): Candle[] {
  const buckets = new Map<number, Candle[]>();
  for (const c of hourly) {
    const d = new Date(c.time);
    const bucketHour = Math.floor(d.getUTCHours() / 4) * 4;
    const bucketStart = Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      bucketHour,
      0,
      0,
      0,
    );
    const arr = buckets.get(bucketStart) ?? [];
    arr.push(c);
    buckets.set(bucketStart, arr);
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([bucketStart, group]) => ({
      time: new Date(bucketStart).toISOString(),
      open: group[0].open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: group[group.length - 1].close,
      volume: group.some((c) => c.volume !== null)
        ? group.reduce((sum, c) => sum + (c.volume ?? 0), 0)
        : null,
    }));
}

export interface LatestPrice {
  price: number;
  /** When that price printed. */
  at: string;
  /** How stale it is right now, in minutes. */
  ageMinutes: number;
}

/**
 * Latest available price, for the 5-minute position monitor.
 *
 * Uses the 5m interval and a 2-minute cache — the analysis TTL of 30 minutes
 * would make a "5-minute monitor" a 30-minute one. The price is still whatever
 * the free tier gives, typically ~15 minutes behind, which is why `ageMinutes`
 * is returned rather than assumed away: every alert built on this states how
 * old the number is.
 */
export async function fetchLatestPrice(
  ticker: string,
  gaps: string[],
): Promise<LatestPrice | null> {
  const result = await fetchFree<{ price: number; at: string }>({
    source: "yahoo",
    label: `即時報價 (${ticker})`,
    key: `yahoo:last:${ticker}`,
    ttlMs: 2 * 60 * 1000,
    limit: YAHOO_LIMIT,
    gaps,
    // A stale quote is worse than none for position management: acting on a
    // two-hour-old price is how a stop gets managed against a market that
    // already moved. Expire it quickly instead.
    staleMs: 10 * 60 * 1000,
    fn: async () => {
      const url =
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
        `?interval=5m&range=1d`;
      const data = await fetchJson<YahooChartResponse>(
        url,
        { headers: { "User-Agent": "Mozilla/5.0" } },
        12000,
      );
      const res = data?.chart?.result?.[0];
      if (!res || !Array.isArray(res.timestamp)) return null;
      const closes = res.indicators?.quote?.[0]?.close ?? [];

      // Walk back to the last non-null close: Yahoo pads the tail of the
      // current session with nulls.
      for (let i = closes.length - 1; i >= 0; i--) {
        const close = closes[i];
        const ts = res.timestamp[i];
        if (close == null || !Number.isFinite(close) || ts == null) continue;
        return { price: close, at: new Date(ts * 1000).toISOString() };
      }
      return null;
    },
  });

  if (!result) return null;
  const ageMinutes = (Date.now() - new Date(result.value.at).getTime()) / 60000;
  return { price: result.value.price, at: result.value.at, ageMinutes };
}

export interface ProxyResult {
  ticker: string;
  timeframe: Timeframe;
  candles: Candle[];
  /** True when served from cache past its TTL — the caller must say so. */
  stale: boolean;
  /** Age of the data in ms; 0 when just fetched. */
  ageMs: number;
}

/**
 * Fetches one timeframe for one Yahoo ticker through the quota/cache/stale
 * pipeline. Returns null rather than throwing, and never invents a candle.
 */
export async function fetchViaProxy(
  ticker: string,
  timeframe: Timeframe,
  gaps: string[],
): Promise<ProxyResult | null> {
  // H4 is derived: the cache key and the upstream call are both in 1h terms
  // and the resample happens afterwards, so the cached copy is the raw hourly
  // series rather than a derived one.
  const cfg = INTERVALS[timeframe];

  const result = await fetchFree<Candle[]>({
    source: "yahoo",
    label: `行情代理 (${ticker} ${timeframe})`,
    key: `yahoo:${ticker}:${cfg.interval}:${cfg.range}`,
    ttlMs: OHLCV_TTL_MS,
    limit: YAHOO_LIMIT,
    gaps,
    fn: async () => {
      const url =
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
        `?interval=${cfg.interval}&range=${cfg.range}`;
      const data = await fetchJson<YahooChartResponse>(
        url,
        { headers: { "User-Agent": "Mozilla/5.0" } },
        12000,
      );
      const res = data?.chart?.result?.[0];
      if (!res || !Array.isArray(res.timestamp)) return null;

      const quote = res.indicators?.quote?.[0] ?? {};
      const candles: Candle[] = res.timestamp
        .map((t, i) => ({
          time: new Date(t * 1000).toISOString(),
          open: quote.open?.[i] ?? NaN,
          high: quote.high?.[i] ?? NaN,
          low: quote.low?.[i] ?? NaN,
          close: quote.close?.[i] ?? NaN,
          volume: quote.volume?.[i] ?? null,
        }))
        // Yahoo pads the arrays with nulls for gaps in the session; dropping
        // those is not data loss, it is the absence of a bar.
        .filter((c) => [c.open, c.high, c.low, c.close].every((n) => Number.isFinite(n)));

      return candles.length > 0 ? candles : null;
    },
  });

  if (!result) return null;

  const candles = timeframe === "H4" ? resampleTo4h(result.value) : result.value;
  if (candles.length === 0) return null;

  return { ticker, timeframe, candles, stale: result.stale, ageMs: result.ageMs };
}

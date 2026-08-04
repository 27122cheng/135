import { getKey } from "../api-keys";
import type { CommodityMeta, Timeframe } from "@/types/signal";
import { cachedOrFetch } from "./cache";
import { checkRateLimit } from "./cache";
import { fetchJson, fetchText } from "./http";

export interface Candle {
  time: string; // ISO 8601
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface OHLCVResult {
  symbol: string;
  timeframe: Timeframe;
  candles: Candle[];
  source: "twelvedata" | "yfinance" | "stooq";
}

const TWELVE_DATA_INTERVAL: Record<Timeframe, string> = {
  M15: "15min",
  H1: "1h",
  H4: "4h",
  D1: "1day",
  W1: "1week",
};

interface TwelveDataValue {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
}

interface TwelveDataResponse {
  status?: string;
  message?: string;
  values?: TwelveDataValue[];
}

async function fetchTwelveDataOHLCV(
  meta: CommodityMeta,
  timeframe: Timeframe,
  outputsize: number,
  gaps: string[],
): Promise<OHLCVResult | null> {
  // Optional: two keyless fallbacks follow, so a missing key is only worth
  // reporting if every source ends up failing (see fetchOHLCV).
  const apiKey = getKey("TWELVE_DATA_API_KEY");
  if (!apiKey) {
    gaps.push("未設定 TWELVE_DATA_API_KEY");
    return null;
  }
  if (!checkRateLimit("twelvedata", 800)) {
    gaps.push(`Twelve Data 今日額度 (800 req/day) 已用盡，OHLCV 改嘗試 yfinance 備援`);
    return null;
  }
  const key = `twelvedata:${meta.twelveDataSymbol}:${timeframe}:${outputsize}`;
  return cachedOrFetch(key, 5 * 60 * 1000, async () => {
    const url =
      `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(meta.twelveDataSymbol)}` +
      `&interval=${TWELVE_DATA_INTERVAL[timeframe]}&outputsize=${outputsize}&apikey=${apiKey}`;
    const data = await fetchJson<TwelveDataResponse>(url);
    if (!data || data.status === "error" || !Array.isArray(data.values)) {
      gaps.push(
        `Twelve Data OHLCV (${meta.symbol} ${timeframe}) 取得失敗${data?.message ? `: ${data.message}` : ""}`,
      );
      return null;
    }
    const candles: Candle[] = data.values
      .map((v) => ({
        time: new Date(v.datetime).toISOString(),
        open: Number(v.open),
        high: Number(v.high),
        low: Number(v.low),
        close: Number(v.close),
        volume: v.volume ? Number(v.volume) : null,
      }))
      .filter((c) => [c.open, c.high, c.low, c.close].every((n) => Number.isFinite(n)))
      .reverse(); // Twelve Data returns newest-first; we want chronological order.
    if (candles.length === 0) {
      gaps.push(`Twelve Data OHLCV (${meta.symbol} ${timeframe}) 回應無有效K棒`);
      return null;
    }
    return { symbol: meta.symbol, timeframe, candles, source: "twelvedata" as const };
  });
}

const YF_INTERVAL: Partial<Record<Timeframe, { interval: string; range: string }>> = {
  M15: { interval: "15m", range: "5d" },
  H1: { interval: "60m", range: "1mo" },
  D1: { interval: "1d", range: "1y" },
  W1: { interval: "1wk", range: "5y" },
};

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      timestamp?: number[];
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
function resampleTo4h(hourly: Candle[]): Candle[] {
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
      high: Math.max(...group.map((c: Candle) => c.high)),
      low: Math.min(...group.map((c: Candle) => c.low)),
      close: group[group.length - 1].close,
      volume: group.some((c: Candle) => c.volume !== null)
        ? group.reduce((sum: number, c: Candle) => sum + (c.volume ?? 0), 0)
        : null,
    }));
}

async function fetchYahooChart(
  meta: CommodityMeta,
  timeframe: Timeframe,
  gaps: string[],
): Promise<OHLCVResult | null> {
  const cfg = YF_INTERVAL[timeframe];
  if (!cfg) {
    gaps.push(`yfinance 備援不支援時框 ${timeframe}`);
    return null;
  }
  const key = `yfinance:${meta.yfinanceSymbol}:${timeframe}`;
  return cachedOrFetch(key, 5 * 60 * 1000, async () => {
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(meta.yfinanceSymbol)}` +
      `?interval=${cfg.interval}&range=${cfg.range}`;
    const data = await fetchJson<YahooChartResponse>(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const result = data?.chart?.result?.[0];
    if (!result || !Array.isArray(result.timestamp)) {
      gaps.push(
        `yfinance OHLCV (${meta.symbol} ${timeframe}) 取得失敗${data?.chart?.error?.description ? `: ${data.chart.error.description}` : ""}`,
      );
      return null;
    }
    const quote = result.indicators?.quote?.[0] ?? {};
    const candles: Candle[] = result.timestamp
      .map((t, i) => ({
        time: new Date(t * 1000).toISOString(),
        open: quote.open?.[i] ?? NaN,
        high: quote.high?.[i] ?? NaN,
        low: quote.low?.[i] ?? NaN,
        close: quote.close?.[i] ?? NaN,
        volume: quote.volume?.[i] ?? null,
      }))
      .filter((c) => [c.open, c.high, c.low, c.close].every((n) => Number.isFinite(n)));
    if (candles.length === 0) {
      gaps.push(`yfinance OHLCV (${meta.symbol} ${timeframe}) 回應無有效K棒`);
      return null;
    }
    return { symbol: meta.symbol, timeframe, candles, source: "yfinance" as const };
  });
}

async function fetchYfinanceOHLCV(
  meta: CommodityMeta,
  timeframe: Timeframe,
  gaps: string[],
): Promise<OHLCVResult | null> {
  if (timeframe === "H4") {
    // Yahoo has no native 4h interval — resample real 1h candles instead of fabricating data.
    const hourly = await fetchYahooChart(meta, "H1", gaps);
    if (!hourly || hourly.candles.length === 0) return null;
    return { symbol: meta.symbol, timeframe: "H4", candles: resampleTo4h(hourly.candles), source: "yfinance" };
  }
  return fetchYahooChart(meta, timeframe, gaps);
}

const STOOQ_INTERVAL: Partial<Record<Timeframe, string>> = { D1: "d", W1: "w" };

/**
 * Stooq's CSV download — a second keyless source, daily/weekly only. Used as a
 * last resort if Yahoo is unavailable (it commonly rate-limits datacenter IPs).
 * The tickers in CommodityMeta.stooqSymbol could not be verified live from the
 * build sandbox, so a wrong one simply yields no rows and falls through.
 */
async function fetchStooqOHLCV(
  meta: CommodityMeta,
  timeframe: Timeframe,
  gaps: string[],
): Promise<OHLCVResult | null> {
  const interval = STOOQ_INTERVAL[timeframe];
  if (!interval) {
    gaps.push(`Stooq 不支援時框 ${timeframe}`);
    return null;
  }
  const key = `stooq:${meta.stooqSymbol}:${timeframe}`;
  return cachedOrFetch(key, 10 * 60 * 1000, async () => {
    const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(meta.stooqSymbol)}&i=${interval}`;
    const csv = await fetchText(url, { headers: { "User-Agent": "Mozilla/5.0" } }, 12000);
    if (!csv || csv.trim().startsWith("<")) {
      gaps.push(`Stooq (${meta.stooqSymbol} ${timeframe}) 取得失敗`);
      return null;
    }
    const lines = csv.trim().split(/\r?\n/);
    const candles: Candle[] = [];
    for (const line of lines.slice(1)) {
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
    if (candles.length === 0) {
      gaps.push(`Stooq (${meta.stooqSymbol} ${timeframe}) 無有效K棒`);
      return null;
    }
    return { symbol: meta.symbol, timeframe, candles, source: "stooq" as const };
  });
}

/**
 * Tries Twelve Data (needs a key), then two keyless public sources: the Yahoo
 * Finance chart endpoint that yfinance wraps, then Stooq's CSV. Never
 * fabricates candles. Individual source failures are only surfaced to `gaps`
 * if every source fails — otherwise a working fallback would report a
 * "gap" that cost the user nothing.
 */
export async function fetchOHLCV(
  meta: CommodityMeta,
  timeframe: Timeframe,
  outputsize: number,
  gaps: string[],
): Promise<OHLCVResult | null> {
  const attempts: string[] = [];
  const primary = await fetchTwelveDataOHLCV(meta, timeframe, outputsize, attempts);
  if (primary) return primary;
  const yahoo = await fetchYfinanceOHLCV(meta, timeframe, attempts);
  if (yahoo) return yahoo;
  const stooq = await fetchStooqOHLCV(meta, timeframe, attempts);
  if (stooq) return stooq;
  gaps.push(`${meta.symbol} ${timeframe} OHLCV 三個來源皆失敗（${attempts.join("；")}）`);
  return null;
}

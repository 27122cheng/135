import type { Timeframe } from "@/types/signal";
import { fetchBackupPrice } from "./backup-price";
import { fetchFree } from "./free-source";
import { fetchJson } from "./http";
import { fetchStooqText } from "./stooq-fetch";
import { fetchTwelveDataQuote } from "./twelvedata";

/**
 * The self-hosted yfinance proxy's engine.
 *
 * "Self-hosted proxy" rather than a vendor API because no hosted quote service
 * covers FX + indices + commodities at once for free and without a key: Twelve
 * Data's free plan gates by market and needs an account, Alpha Vantage's is
 * down to ~25 requests a day. The Yahoo chart endpoint that the `yfinance`
 * library wraps covers all nine tickers for free — so we call it from our own
 * server, cache it for 30 minutes, and spend a self-imposed budget against it.
 *
 * Twelve Data is now wired in as an *optional* extra witness for the live
 * quote (see ./twelvedata.ts): a key makes it a third company on the live
 * chain, no key changes nothing. It is a backup, not the primary — the whole
 * point of the proxy is that the site works for someone who has pasted no keys
 * at all.
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
export const YAHOO_LIMIT = { perMinute: 60, perDay: 2000 };

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

type YahooChartResult = NonNullable<NonNullable<YahooChartResponse["chart"]>["result"]>[number];

/**
 * Yahoo serves the chart API from more than one hostname, and the freeze that
 * put nine open instruments on 休市中 was host-shaped: query1 served this
 * deployment perfectly valid 200s whose data stopped at the previous Thursday,
 * for days. Whether that is a poisoned edge cache or per-host rate shaping,
 * asking the second hostname is nearly free and answers it either way.
 *
 * A host's answer is accepted immediately only while it is *actually fresh*
 * for its purpose — `freshEnoughMs` is the caller's, because "fresh" means
 * 30 minutes for a live quote and a few hours for an H4 series. The first
 * cut used one four-day threshold (the frozen-proxy bound), which meant a
 * host serving six-hour-old prices was accepted without ever asking the
 * second host — and six hours of quote lag is exactly what kept open markets
 * reading 休市中. Below the threshold the other host is asked too and the
 * freshest answer wins.
 */
const YAHOO_HOSTS = ["query1", "query2"] as const;

export async function fetchYahooChart(
  pathAndQuery: string,
  freshEnoughMs: number,
): Promise<YahooChartResult | null> {
  let best: { res: YahooChartResult; newest: number } | null = null;
  for (const host of YAHOO_HOSTS) {
    const data = await fetchJson<YahooChartResponse>(
      `https://${host}.finance.yahoo.com/v8/finance/chart/${pathAndQuery}`,
      { headers: { "User-Agent": "Mozilla/5.0" } },
      8000,
    );
    const res = data?.chart?.result?.[0];
    const ts = res?.timestamp;
    if (!res || !Array.isArray(ts) || ts.length === 0) continue;
    const newest = ts[ts.length - 1] * 1000;
    if (Date.now() - newest <= freshEnoughMs) return res;
    if (!best || newest > best.newest) best = { res, newest };
  }
  return best?.res ?? null;
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
  /** Which feed answered — direct quote, Stooq, a third-witness source, or the candle proxy's newest bar. */
  source?:
    | "yahoo-direct"
    | "stooq"
    | "twelvedata"
    | "proxy-bar"
    | "fred"
    | "er-api"
    | "gold-api";
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
  /** Stooq's symbol for the same instrument — enables the independent fallback. */
  stooqTicker?: string,
  /** Our symbol — enables the third-witness backup sources (FRED / ER-API / gold-api). */
  symbol?: string,
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
      // A quote is fresh for half an hour; staler than that and the second
      // host gets a chance to beat it before the staleness gate fires.
      const res = await fetchYahooChart(
        `${encodeURIComponent(ticker)}?interval=5m&range=1d`,
        30 * 60 * 1000,
      );
      if (!res || !Array.isArray(res.timestamp)) return null;
      const closes = res.indicators?.quote?.[0]?.close ?? [];

      // `meta.regularMarketTime` is when the instrument actually last traded.
      // The bar timestamp is not: over a weekend Yahoo keeps emitting a bar for
      // the current five-minute boundary carrying Friday's close forward, so a
      // quote 40 hours old reported its age as 0 minutes and the card said
      // "分析當下價格，0 分鐘前" about a market that had been shut since Friday.
      const lastTrade = res.meta?.regularMarketTime;

      // Walk back to the last non-null close: Yahoo pads the tail of the
      // current session with nulls.
      for (let i = closes.length - 1; i >= 0; i--) {
        const close = closes[i];
        const ts = res.timestamp[i];
        if (close == null || !Number.isFinite(close) || ts == null) continue;
        // The earlier of the two. A carried-forward bar cannot make the quote
        // look fresher than the last trade, and a `regularMarketTime` running
        // ahead of the bars (it does, intraday) cannot make it look staler.
        const at = lastTrade && lastTrade < ts ? lastTrade : ts;
        return { price: close, at: new Date(at * 1000).toISOString() };
      }
      return null;
    },
  });

  const direct: LatestPrice | null = result
    ? {
        price: result.value.price,
        at: result.value.at,
        ageMinutes: (Date.now() - new Date(result.value.at).getTime()) / 60000,
        source: "yahoo-direct" as const,
      }
    : null;
  if (direct && direct.ageMinutes <= 3 * 60) return direct;

  // Second opinion, different company. The proxy-bar fallback added first
  // turned out to share Yahoo's upstream, and when Yahoo froze this
  // deployment's data at the previous Thursday, both "independent" witnesses
  // told the same lie and every card said 休市中 for days. Stooq is a separate
  // provider entirely, keyless, with a latest-quote CSV — so a Yahoo-side
  // freeze can no longer take out every price at once.
  //
  // Stooq stamps quotes in Warsaw local time (UTC+1/+2). Parsed as UTC the
  // timestamp reads up to two hours *fresher* than reality — harmless for the
  // staleness gate (the weekend clock covers the close, and two hours is under
  // every threshold here) and preferable to a timezone table that rots.
  const live: LatestPrice[] = direct ? [direct] : [];
  if (stooqTicker) {
    const stooq = await fetchStooqQuote(stooqTicker, gaps).catch(() => null);
    if (stooq) live.push(stooq);
  }

  // Third live witness, third company — and the only one of the three that is
  // a paid-grade vendor rather than an endpoint we are borrowing. Optional: no
  // key, no call, and the chain behaves exactly as it did before. It matters
  // most for GER40, which has no keyless third source of any kind (FRED's DAX
  // series is discontinued), and on the days Yahoo freezes — the failure that
  // put nine trading instruments on 休市中 for a day and a half.
  //
  // Reached only once Yahoo's own answer is over three hours old (the early
  // return above), so a normal day spends none of the 800-call daily budget on
  // it. That is deliberate: a backup that burns its allowance while the primary
  // is healthy is not available on the day the primary fails.
  if (symbol) {
    const td = await fetchTwelveDataQuote({ symbol }, gaps).catch(() => null);
    if (td) live.push(td);
  }

  // Freshest live answer wins, and if it is genuinely recent nothing further
  // is asked. The daily sources below exist for when every live feed is dark.
  if (live.length > 0) {
    const freshest = live.reduce((best, c) => (c.ageMinutes < best.ageMinutes ? c : best));
    if (freshest.ageMinutes <= 3 * 60 || freshest !== direct) return freshest;
  }

  // Third witness, third company. FRED publishes the US index closes and the
  // WTI settle, ER-API publishes daily FX fixes, gold-api the spot gold price —
  // all keyless and none of them Yahoo or Stooq. Daily data, so it never wins
  // while anything live is answering; it exists for the day both quote sources
  // are dark, when yesterday's real close beats last Thursday's frozen one.
  const candidates: LatestPrice[] = direct ? [direct] : [];
  if (symbol) {
    const backup = await fetchBackupPrice(symbol, gaps).catch(() => null);
    if (backup) {
      // Plausibility check against any Yahoo-side witness we have. The backup
      // sources are hand-mapped (symbol → FRED series / ER-API currency), and
      // a wrong mapping would serve a confidently-timestamped price for a
      // different instrument — which the freshness rule would then *prefer*
      // whenever the live feeds are dark. Days of drift on an index is a few
      // percent; 15% apart means one of the two is not this market, and the
      // hand-mapped one is the suspect.
      const reference = direct?.price;
      const implausible =
        reference !== undefined && Math.abs(backup.price - reference) / reference > 0.15;
      if (implausible) {
        gaps.push(
          `備援報價 (${backup.source}) 與主來源價格相差超過 15%（${backup.price} vs ${reference}），疑似對應錯誤的商品，本次不採用`,
        );
      } else {
        candidates.push({
          ...backup,
          ageMinutes: Math.max(0, (Date.now() - new Date(backup.at).getTime()) / 60000),
        });
      }
    }
  }

  // The proxy's newest hourly bar — same upstream as the direct quote, but the
  // chart endpoint sometimes answers when the 5m one doesn't.
  const proxied = await fetchViaProxy(ticker, "H4", gaps).catch(() => null);
  const bar = proxied?.candles.at(-1);
  if (bar) {
    candidates.push({
      price: bar.close,
      at: bar.time,
      ageMinutes: Math.max(0, (Date.now() - new Date(bar.time).getTime()) / 60000),
      source: "proxy-bar",
    });
  }

  // Whoever printed most recently is the least-wrong answer; an old price
  // beats none, and its age is always carried along, never flattered.
  if (candidates.length === 0) return null;
  return candidates.reduce((best, c) => (c.ageMinutes < best.ageMinutes ? c : best));
}

/**
 * Stooq's keyless latest-quote endpoint: one CSV line per symbol,
 * `Symbol,Date,Time,Open,High,Low,Close,Volume`, "N/D" when unknown.
 */
async function fetchStooqQuote(stooqTicker: string, gaps: string[]): Promise<LatestPrice | null> {
  const result = await fetchFree<{ price: number; at: string }>({
    source: "stooq",
    label: `Stooq 報價 (${stooqTicker})`,
    key: `stooq:last:${stooqTicker}`,
    ttlMs: 2 * 60 * 1000,
    limit: { perMinute: 30 },
    gaps,
    staleMs: 10 * 60 * 1000,
    fn: async () => {
      const text = await fetchStooqText(
        `/q/l/?s=${encodeURIComponent(stooqTicker)}&f=sd2t2ohlcv&h&e=csv`,
        6000,
      );
      if (!text) return null;
      const line = text.trim().split("\n")[1];
      if (!line) return null;
      const cols = line.split(",");
      const [, date, time] = cols;
      const close = Number(cols[6]);
      if (!date || date === "N/D" || !Number.isFinite(close) || close <= 0) return null;
      const at = new Date(`${date}T${time && time !== "N/D" ? time : "00:00:00"}Z`).toISOString();
      return { price: close, at };
    },
  });
  if (!result) return null;
  return {
    price: result.value.price,
    at: result.value.at,
    ageMinutes: Math.max(0, (Date.now() - new Date(result.value.at).getTime()) / 60000),
    source: "stooq",
  };
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
  /**
   * Overrides the range for this call — the lab asks for a decade of daily
   * bars, the analysis asks for a year. Both go through the same quota, cache
   * and stale machinery; the range is part of the cache key, so the two never
   * overwrite each other's copy.
   */
  rangeOverride?: string,
): Promise<ProxyResult | null> {
  // H4 is derived: the cache key and the upstream call are both in 1h terms
  // and the resample happens afterwards, so the cached copy is the raw hourly
  // series rather than a derived one.
  const base = INTERVALS[timeframe];
  const cfg = rangeOverride ? { ...base, range: rangeOverride } : base;

  const result = await fetchFree<Candle[]>({
    source: "yahoo",
    label: `行情代理 (${ticker} ${timeframe})`,
    key: `yahoo:${ticker}:${cfg.interval}:${cfg.range}`,
    ttlMs: OHLCV_TTL_MS,
    limit: YAHOO_LIMIT,
    gaps,
    fn: async () => {
      // Candles are fresh for five hours (an H4 bucket plus slack); beyond
      // that the second host is asked and the freshest series wins.
      const res = await fetchYahooChart(
        `${encodeURIComponent(ticker)}?interval=${cfg.interval}&range=${cfg.range}`,
        5 * 60 * 60 * 1000,
      );
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

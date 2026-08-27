import type { CommodityMeta } from "@/types/signal";
import { fetchBinanceDeep } from "./binance-crypto";
import { CANDLE_STALE_MS } from "./cache";
import { fetchFree } from "./free-source";
import { fetchStooqText } from "./stooq-fetch";
import { fetchTwelveDataOHLCV } from "./twelvedata";
import { fetchViaProxy, type Candle } from "./yfinance";

/**
 * 深度歷史 — years of daily bars, for the lab alone.
 *
 * ## Why this exists
 *
 * The analysis fetches one year of D1 (`INTERVALS` in yfinance.ts), which is
 * the right amount for reading a trend and far too little to measure one. With
 * ~250 bars, a 70/30 split leaves 175 in-sample bars, minus 60 of indicator
 * warm-up and 20 of horizon: **95 candidate entries at the absolute maximum**,
 * reachable only by a condition that is true on literally every bar. The
 * operator's floor is 100 resolved trades. So on a one-year series nothing
 * could ever be verified — not because no condition works, but because the
 * arithmetic forbids it. The lab was measuring in a room too small to hold the
 * measurement.
 *
 * A decade of daily bars gives ~2,500, of which ~1,670 are candidate in-sample
 * entries. A condition that fires on 10% of bars then produces a real sample
 * instead of a rounding error.
 *
 * ## Why it is separate from fetchOHLCV
 *
 * Ten times the payload on every scan, for nine symbols, cached into a
 * free-tier database, to serve an analysis that reads the last 200 bars — that
 * is a cost with no benefit. So this is its own fetch with its own cache key
 * and a long TTL, called only by the lab, and the analysis is untouched.
 *
 * ## Sources
 *
 * The proxy is asked for 10 years first. Stooq's CSV is the fallback and often
 * the deeper one — it serves complete history in a single keyless request —
 * but its tickers are the less certain of the two, so it goes second and its
 * answer is used when the proxy's is missing or short.
 */

/** Below this many bars the deep fetch has not earned its name. */
const SHORT_SERIES = 600;
/** Daily bars change once a day; a lab run does not need a fresher copy. */
const TTL_MS = 12 * 60 * 60 * 1000;

export interface DeepHistory {
  candles: Candle[];
  source: "yfinance-proxy" | "stooq" | "twelvedata" | "binance";
  /** Span of the series in years, one decimal. */
  years: number;
  stale: boolean;
}

function span(candles: Candle[]): number {
  if (candles.length < 2) return 0;
  const first = new Date(candles[0].time).getTime();
  const last = new Date(candles[candles.length - 1].time).getTime();
  return Math.round(((last - first) / (365.25 * 86_400_000)) * 10) / 10;
}

/** Stooq's full daily CSV — no key, no date range, the whole series. */
async function fetchStooqFull(meta: CommodityMeta, gaps: string[]): Promise<Candle[] | null> {
  const result = await fetchFree<Candle[]>({
    source: "stooq",
    label: `Stooq 完整日線 (${meta.stooqSymbol})`,
    key: `stooq:deep:${meta.stooqSymbol}`,
    ttlMs: TTL_MS,
    // A deep history that is a few days behind is still a deep history —
    // the lab reads thousands of bars, and the newest handful barely move
    // any measurement. Same week-long leash all candle series get.
    staleMs: CANDLE_STALE_MS,
    limit: { perMinute: 30, perDay: 1000 },
    gaps,
    fn: async () => {
      const csv = await fetchStooqText(`/q/d/l/?s=${encodeURIComponent(meta.stooqSymbol)}&i=d`);
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
  return result?.value ?? null;
}

/**
 * As many daily bars as the free sources will give. Null when both fail —
 * never a short series dressed up as a deep one.
 */
export async function fetchDeepD1(
  meta: CommodityMeta,
  gaps: string[],
): Promise<DeepHistory | null> {
  // Crypto: the venue's own paged klines (up to 3,000 daily bars ≈ 8 years),
  // keyless and realtime — the mirrors below stay as fallbacks.
  if (meta.category === "crypto") {
    const binance = await fetchBinanceDeep(meta, "D1", gaps);
    if (binance && binance.length >= SHORT_SERIES) {
      return { candles: binance, source: "binance", years: span(binance), stale: false };
    }
  }

  const proxyGaps: string[] = [];
  const proxied = await fetchViaProxy(meta.yfinanceSymbol, "D1", proxyGaps, "10y");
  const fromProxy = proxied?.candles ?? null;

  // Long enough on its own: take it and skip the second request entirely.
  if (fromProxy && fromProxy.length >= SHORT_SERIES) {
    for (const g of proxyGaps) if (g.includes("stale")) gaps.push(g);
    return {
      candles: fromProxy,
      source: "yfinance-proxy",
      years: span(fromProxy),
      stale: proxied!.stale,
    };
  }

  const stooq = await fetchStooqFull(meta, gaps);
  // Whichever actually goes back further wins; a fallback that returns less
  // than the primary is not a fallback worth taking.
  if (stooq && stooq.length >= SHORT_SERIES && (!fromProxy || stooq.length > fromProxy.length)) {
    return { candles: stooq, source: "stooq", years: span(stooq), stale: false };
  }

  // Third leg: Twelve Data's time_series reaches back up to 5,000 daily bars
  // (~19 years) on one credit. Keyed and rate-limited, so it comes after both
  // keyless sources — but before settling for a short series.
  const td = await fetchTwelveDataOHLCV(meta, "D1", gaps, {
    outputsize: 5000,
    ttlMs: TTL_MS,
  });
  const best = [fromProxy, stooq, td]
    .filter((c): c is Candle[] => c !== null && c.length > 0)
    .reduce<Candle[] | null>((a, c) => (a === null || c.length > a.length ? c : a), null);
  if (best) {
    if (best.length < SHORT_SERIES) {
      gaps.push(
        `${meta.symbol} 深度歷史只取得 ${best.length} 根日線（所有來源都提供不了更長的序列），` +
          `樣本數可能不足以通過驗證門檻`,
      );
    }
    const source = best === td ? "twelvedata" : best === stooq ? "stooq" : "yfinance-proxy";
    return {
      candles: best,
      source,
      years: span(best),
      stale: source === "yfinance-proxy" ? proxied!.stale : false,
    };
  }
  gaps.push(`${meta.symbol} 取不到深度日線歷史（行情代理、Stooq 與 Twelve Data 皆失敗）`);
  return null;
}

/**
 * 深度 H4 — two years of 4-hour bars, again for the lab alone.
 *
 * The analysis fetches three months of H4; the lab needs the depth. Yahoo's
 * 60m interval reaches back 730 days, which resamples to roughly 2,500–2,800
 * four-hour bars — the same order of sample the ten-year daily series gives,
 * arriving six times faster per calendar day. That speed is the whole point:
 * a condition needs 100 in-sample trades before it may be believed, and on
 * H4 that evidence accumulates in weeks rather than quarters.
 *
 * Proxy only: Stooq's keyless CSV serves daily and weekly, so there is no
 * second source to fall back to. A short series is reported honestly rather
 * than padded.
 */
export async function fetchDeepH4(
  meta: CommodityMeta,
  gaps: string[],
): Promise<DeepHistory | null> {
  // Crypto: 3,000 native 4h bars ≈ 16 months, straight from the venue.
  if (meta.category === "crypto") {
    const binance = await fetchBinanceDeep(meta, "H4", gaps);
    if (binance && binance.length >= SHORT_SERIES) {
      return { candles: binance, source: "binance", years: span(binance), stale: false };
    }
  }

  // Progressive ranges: the full 730-day hourly request is ~17,000 raw bars
  // in one Yahoo response, and it is precisely the request most likely to
  // time out or be refused when the upstream is grumpy — which then read as
  // 取不到 K 棒 while a smaller request would have succeeded. 365d ≈ 1,500
  // and 180d ≈ 780 four-hour bars, both still above the sample floor.
  const proxyGaps: string[] = [];
  let proxied: Awaited<ReturnType<typeof fetchViaProxy>> = null;
  for (const range of ["730d", "365d", "180d"]) {
    proxied = await fetchViaProxy(meta.yfinanceSymbol, "H4", proxyGaps, range);
    if (proxied?.candles?.length) break;
  }
  const fromProxy = proxied?.candles ?? null;
  if (fromProxy && fromProxy.length >= SHORT_SERIES) {
    for (const g of proxyGaps) if (g.includes("stale")) gaps.push(g);
    return {
      candles: fromProxy,
      source: "yfinance-proxy",
      years: span(fromProxy),
      stale: proxied!.stale,
    };
  }

  // Twelve Data serves native 4h bars up to 5,000 deep (~3 years) — actually
  // *further* back than Yahoo's two-year hourly cap. Keyed, so it is the
  // fallback rather than the default.
  const td = await fetchTwelveDataOHLCV(meta, "H4", gaps, { outputsize: 5000, ttlMs: TTL_MS });
  const best =
    td && (!fromProxy || td.length > fromProxy.length) ? td : fromProxy;
  if (!best || best.length === 0) {
    gaps.push(
      `${meta.symbol} 取不到深度 H4 歷史（Yahoo 60 分鐘資料與 Twelve Data 4h 皆失敗）`,
    );
    return null;
  }
  if (best.length < SHORT_SERIES) {
    gaps.push(
      `${meta.symbol} 深度 H4 只取得 ${best.length} 根，樣本數可能不足以通過驗證門檻`,
    );
  }
  const source = best === td ? "twelvedata" : "yfinance-proxy";
  if (source === "yfinance-proxy") {
    for (const g of proxyGaps) if (g.includes("stale")) gaps.push(g);
  }
  return {
    candles: best,
    source,
    years: span(best),
    stale: source === "yfinance-proxy" ? proxied!.stale : false,
  };
}

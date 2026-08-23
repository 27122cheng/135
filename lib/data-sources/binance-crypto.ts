import type { CommodityMeta, Timeframe } from "@/types/signal";
import { CANDLE_STALE_MS } from "./cache";
import { fetchFree } from "./free-source";
import { fetchJson } from "./http";
import type { Candle, LatestPrice } from "./yfinance";

/**
 * Binance as a *primary* source — for crypto instruments only.
 *
 * This is a different animal from lib/data-sources/binance-witness.ts, and
 * the difference is the whole design. The witness watches proxies (PAXG for
 * gold, USDT pairs for FX majors) whose basis differs from the instrument
 * being traded, so it is pinned to never set a price. A user-added BTCUSD is
 * the opposite case: Binance *is* the venue, its prints are the market, and
 * routing crypto through Yahoo's delayed mirror of exchange data while the
 * exchange's own keyless API sits unused is how BTCUSD showed 週末休市 and
 * "D1 K 棒不足" on an instrument that trades every second of the year.
 *
 * Keyless, generous limits (the public data endpoints allow ~1,200 request
 * weight/minute; a whole sweep uses a fraction of one percent of that), and
 * the only source in this codebase whose quotes are genuinely realtime.
 */

const INTERVALS: Record<Timeframe, string> = { H4: "4h", D1: "1d", W1: "1w" };

/**
 * "BTC-USD" (Yahoo's crypto form) → "BTCUSDT". USDT, not USD: Binance's USD
 * pairs are thin or absent while the USDT book carries the volume, and for a
 * price feed the ~0.1% stablecoin basis is far below the spread this system
 * already charges. Tickers already in exchange form (BTCUSDT) pass through.
 */
export function binanceSymbolFor(yahooTicker: string): string | null {
  const t = yahooTicker.trim().toUpperCase();
  const dashUsd = t.match(/^([A-Z0-9]{2,10})-(USD[TC]?)$/);
  if (dashUsd) return `${dashUsd[1]}${dashUsd[2] === "USD" ? "USDT" : dashUsd[2]}`;
  if (/^[A-Z0-9]{2,10}(USDT|USDC)$/.test(t)) return t;
  return null;
}

/** Whether a Yahoo-form ticker denotes a crypto instrument. */
export function isCryptoTicker(yahooTicker: string): boolean {
  return binanceSymbolFor(yahooTicker) !== null;
}

/** Kline row: [openTime, open, high, low, close, volume, closeTime, ...]. */
type Kline = [number, string, string, string, string, string, number, ...unknown[]];

function toCandles(rows: Kline[]): Candle[] {
  const candles: Candle[] = [];
  for (const r of rows) {
    const [openTime, open, high, low, close, volume] = r;
    const o = Number(open);
    const h = Number(high);
    const l = Number(low);
    const c = Number(close);
    const v = Number(volume);
    if (![o, h, l, c].every((n) => Number.isFinite(n) && n > 0)) continue;
    candles.push({
      time: new Date(openTime).toISOString(),
      open: o,
      high: h,
      low: l,
      close: c,
      volume: Number.isFinite(v) && v > 0 ? v : null,
    });
  }
  return candles;
}

/**
 * One page of klines, already oldest-first from the exchange.
 * `endTime` (exclusive) pages backwards for the deep fetch.
 */
async function fetchKlines(
  pair: string,
  interval: string,
  limit: number,
  endTime?: number,
): Promise<Candle[] | null> {
  const url =
    `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(pair)}` +
    `&interval=${interval}&limit=${limit}` +
    (endTime ? `&endTime=${endTime}` : "");
  const rows = await fetchJson<Kline[]>(url, undefined, 7000);
  if (!Array.isArray(rows)) return null;
  const candles = toCandles(rows);
  return candles.length > 0 ? candles : null;
}

/** OHLCV for a crypto instrument — the chain's first leg for that category. */
export async function fetchBinanceOHLCV(
  meta: Pick<CommodityMeta, "symbol" | "yfinanceSymbol">,
  timeframe: Timeframe,
  gaps: string[],
  opts: { ttlMs: number },
): Promise<Candle[] | null> {
  const pair = binanceSymbolFor(meta.yfinanceSymbol);
  if (!pair) return null;
  const interval = INTERVALS[timeframe];

  const result = await fetchFree<Candle[]>({
    source: "binance",
    label: `Binance K 棒 (${pair} ${timeframe})`,
    key: `binance:klines:${pair}:${interval}`,
    ttlMs: opts.ttlMs,
    staleMs: CANDLE_STALE_MS,
    // Self-imposed far below the exchange's ceiling.
    limit: { perMinute: 30 },
    gaps,
    fn: () => fetchKlines(pair, interval, 1000),
  });
  return result?.value ?? null;
}

/** How many 1,000-bar pages the deep fetch walks back. 3,000 D1 ≈ 8 years. */
const DEEP_PAGES = 3;
/** Deep copies change slowly; half a day matches the other deep fetches. */
const DEEP_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Deep history for the lab: up to 3,000 bars, paged backwards through
 * `endTime`. One cache entry for the whole assembled series, so the three
 * upstream requests are paid once per half-day per symbol and timeframe.
 */
export async function fetchBinanceDeep(
  meta: Pick<CommodityMeta, "symbol" | "yfinanceSymbol">,
  timeframe: Timeframe,
  gaps: string[],
): Promise<Candle[] | null> {
  const pair = binanceSymbolFor(meta.yfinanceSymbol);
  if (!pair) return null;
  const interval = INTERVALS[timeframe];

  const result = await fetchFree<Candle[]>({
    source: "binance",
    label: `Binance 深度 K 棒 (${pair} ${timeframe})`,
    key: `binance:deep:${pair}:${interval}`,
    ttlMs: DEEP_TTL_MS,
    staleMs: CANDLE_STALE_MS,
    limit: { perMinute: 30 },
    gaps,
    fn: async () => {
      let assembled: Candle[] = [];
      let endTime: number | undefined;
      for (let page = 0; page < DEEP_PAGES; page++) {
        const batch = await fetchKlines(pair, interval, 1000, endTime);
        if (!batch) break;
        assembled = [...batch, ...assembled];
        // A short page means the listing's beginning was reached.
        if (batch.length < 1000) break;
        endTime = new Date(batch[0].time).getTime() - 1;
      }
      return assembled.length > 0 ? assembled : null;
    },
  });
  return result?.value ?? null;
}

/**
 * The last print, from the newest 1-minute kline — a real trade with a real
 * timestamp, never the local clock. Same shape as every other quote source so
 * the freshness contest treats it identically.
 */
export async function fetchBinanceQuote(
  meta: Pick<CommodityMeta, "symbol" | "yfinanceSymbol">,
  gaps: string[],
): Promise<LatestPrice | null> {
  const pair = binanceSymbolFor(meta.yfinanceSymbol);
  if (!pair) return null;

  const result = await fetchFree<{ price: number; at: string }>({
    source: "binance",
    label: `Binance 即時報價 (${pair})`,
    key: `binance:quote:${pair}`,
    ttlMs: 60 * 1000,
    // A stale quote is worse than none for position management.
    staleMs: 10 * 60 * 1000,
    limit: { perMinute: 30 },
    gaps,
    fn: async () => {
      const rows = await fetchJson<Kline[]>(
        `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(pair)}&interval=1m&limit=1`,
        undefined,
        7000,
      );
      if (!Array.isArray(rows) || rows.length === 0) return null;
      const last = rows[rows.length - 1];
      const price = Number(last[4]);
      const openTime = Number(last[0]);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(openTime)) return null;
      // The bar's open time understates freshness by at most a minute, and
      // unlike closeTime it can never sit in the future mid-bar.
      return { price, at: new Date(openTime).toISOString() };
    },
  });

  if (!result) return null;
  return {
    price: result.value.price,
    at: result.value.at,
    ageMinutes: Math.max(0, (Date.now() - new Date(result.value.at).getTime()) / 60000),
    source: "binance",
  };
}

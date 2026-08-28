import type { CommodityMeta, Timeframe } from "@/types/signal";
import { CANDLE_STALE_MS } from "./cache";
import { binanceSymbolFor } from "./binance-crypto";
import { fetchFree } from "./free-source";
import { fetchJson } from "./http";
import type { Candle, LatestPrice } from "./yfinance";

/**
 * Kraken as the second crypto venue — because the first is unreachable from
 * where this code runs.
 *
 * api.binance.com geo-blocks US IP ranges (HTTP 451), and Vercel's functions
 * for this deployment run in US data centers. The "Binance 目前連線不穩
 * （已連續失敗 6 次）" lines in every production sweep are therefore not
 * flakiness to be retried through: the venue refuses the deployment's region
 * outright and permanently. Locally (and from most non-US regions) Binance
 * still answers, so it stays first in the chain; Kraken is the leg that makes
 * crypto data actually exist in production.
 *
 * Kraken's public market-data endpoints are keyless, explicitly serve the US,
 * and quote real USD pairs — no stablecoin basis at all. Limits are modest
 * (~1 request/second sustained for public endpoints), far above what a sweep
 * uses. The one real constraint: OHLC returns at most the newest 720 bars per
 * interval regardless of `since`, so deep D1 history tops out around two
 * years — enough to clear the lab's SHORT_SERIES bar, stated honestly in the
 * source label rather than padded.
 */

const INTERVALS: Record<Timeframe, number> = { H4: 240, D1: 1440, W1: 10080 };

/**
 * "BTC-USD" → "XBTUSD". Kraken's legacy code for bitcoin is XBT, and its
 * books are real USD. Reuses the Binance normaliser for detection so the two
 * venues always agree on what counts as crypto.
 */
export function krakenPairFor(yahooTicker: string): string | null {
  const b = binanceSymbolFor(yahooTicker);
  if (!b) return null;
  const base = b.replace(/(USDT|USDC)$/, "");
  return `${base === "BTC" ? "XBT" : base}USD`;
}

/** Kraken wraps every payload: {error: string[], result: {...}}. */
interface KrakenEnvelope<T> {
  error?: string[];
  result?: T;
}

/** OHLC row: [time(sec), open, high, low, close, vwap, volume, count]. */
type OhlcRow = [number, string, string, string, string, string, string, number];

/**
 * The result object keys pairs by Kraken's internal name (XXBTZUSD for
 * XBTUSD); taking the first non-`last` key sidesteps the aliasing table.
 */
function firstPairValue<T>(result: Record<string, unknown> | undefined): T | null {
  if (!result) return null;
  for (const [k, v] of Object.entries(result)) {
    if (k !== "last") return v as T;
  }
  return null;
}

function toCandles(rows: OhlcRow[]): Candle[] {
  const candles: Candle[] = [];
  for (const r of rows) {
    const [time, open, high, low, close, , volume] = r;
    const o = Number(open);
    const h = Number(high);
    const l = Number(low);
    const c = Number(close);
    const v = Number(volume);
    if (!Number.isFinite(time) || ![o, h, l, c].every((n) => Number.isFinite(n) && n > 0)) continue;
    candles.push({
      time: new Date(time * 1000).toISOString(),
      open: o,
      high: h,
      low: l,
      close: c,
      volume: Number.isFinite(v) && v > 0 ? v : null,
    });
  }
  // Kraken's newest row is the still-forming bar; it is a real partial print
  // like every other source's last bar, so it stays — the analyzers already
  // treat the last candle as live.
  return candles;
}

async function fetchOhlcRows(pair: string, interval: number): Promise<Candle[] | null> {
  const data = await fetchJson<KrakenEnvelope<Record<string, unknown>>>(
    `https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(pair)}&interval=${interval}`,
    undefined,
    8000,
  );
  if (!data || (Array.isArray(data.error) && data.error.length > 0)) return null;
  const rows = firstPairValue<OhlcRow[]>(data.result);
  if (!Array.isArray(rows)) return null;
  const candles = toCandles(rows);
  return candles.length > 0 ? candles : null;
}

/** OHLCV from Kraken — the crypto chain's second venue leg. */
export async function fetchKrakenOHLCV(
  meta: Pick<CommodityMeta, "symbol" | "yfinanceSymbol">,
  timeframe: Timeframe,
  gaps: string[],
  opts: { ttlMs: number },
): Promise<Candle[] | null> {
  const pair = krakenPairFor(meta.yfinanceSymbol);
  if (!pair) return null;
  const interval = INTERVALS[timeframe];

  const result = await fetchFree<Candle[]>({
    source: "kraken",
    label: `Kraken K 棒 (${pair} ${timeframe})`,
    key: `kraken:ohlc:${pair}:${interval}`,
    ttlMs: opts.ttlMs,
    staleMs: CANDLE_STALE_MS,
    limit: { perMinute: 20 },
    gaps,
    fn: () => fetchOhlcRows(pair, interval),
  });
  return result?.value ?? null;
}

/** Deep copies change slowly; half a day matches the other deep fetches. */
const DEEP_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Deep history for the lab: Kraken serves the newest 720 bars per interval —
 * about two years of D1 — with no way to page further back. Shorter than
 * Binance's 3,000 but real, and in the US region it is the difference between
 * a lab that runs and 取不到 K 棒.
 */
export async function fetchKrakenDeep(
  meta: Pick<CommodityMeta, "symbol" | "yfinanceSymbol">,
  timeframe: Timeframe,
  gaps: string[],
): Promise<Candle[] | null> {
  const pair = krakenPairFor(meta.yfinanceSymbol);
  if (!pair) return null;
  const result = await fetchFree<Candle[]>({
    source: "kraken",
    label: `Kraken 深度 K 棒 (${pair} ${timeframe})`,
    key: `kraken:deep:${pair}:${INTERVALS[timeframe]}`,
    ttlMs: DEEP_TTL_MS,
    staleMs: CANDLE_STALE_MS,
    limit: { perMinute: 20 },
    gaps,
    fn: () => fetchOhlcRows(pair, INTERVALS[timeframe]),
  });
  return result?.value ?? null;
}

/** Trades row: [price, volume, time(sec float), side, type, misc, id]. */
type TradeRow = [string, string, number, string, string, string, number];

/**
 * The last actual trade, with the venue's own timestamp — same honesty
 * contract as the Binance quote: a real print, never the local clock.
 */
export async function fetchKrakenQuote(
  meta: Pick<CommodityMeta, "symbol" | "yfinanceSymbol">,
  gaps: string[],
): Promise<LatestPrice | null> {
  const pair = krakenPairFor(meta.yfinanceSymbol);
  if (!pair) return null;

  const result = await fetchFree<{ price: number; at: string }>({
    source: "kraken",
    label: `Kraken 即時報價 (${pair})`,
    key: `kraken:quote:${pair}`,
    ttlMs: 60 * 1000,
    staleMs: 10 * 60 * 1000,
    limit: { perMinute: 20 },
    gaps,
    fn: async () => {
      const data = await fetchJson<KrakenEnvelope<Record<string, unknown>>>(
        `https://api.kraken.com/0/public/Trades?pair=${encodeURIComponent(pair)}&count=1`,
        undefined,
        8000,
      );
      if (!data || (Array.isArray(data.error) && data.error.length > 0)) return null;
      const rows = firstPairValue<TradeRow[]>(data.result);
      if (!Array.isArray(rows) || rows.length === 0) return null;
      const last = rows[rows.length - 1];
      const price = Number(last[0]);
      const time = Number(last[2]);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(time)) return null;
      return { price, at: new Date(time * 1000).toISOString() };
    },
  });

  if (!result) return null;
  return {
    price: result.value.price,
    at: result.value.at,
    ageMinutes: Math.max(0, (Date.now() - new Date(result.value.at).getTime()) / 60000),
    source: "kraken",
  };
}

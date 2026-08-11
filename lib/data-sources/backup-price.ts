import type { SupportedSymbol } from "@/types/signal";
import { fetchFredSeriesById } from "./fred";
import { fetchFree } from "./free-source";
import { fetchJson } from "./http";

/**
 * 第三證人 — a latest price from a company that is neither Yahoo nor Stooq.
 *
 * The deployment hit the day this exists for: Yahoo frozen at the previous
 * Thursday (serving 200s, so nothing "failed"), Stooq unreachable from the
 * egress IP, and every card carrying a six-day-old price. Two witnesses is
 * only redundancy while they fail independently; these are a third family
 * with different owners, different hosting, and no key required:
 *
 *  - US index closes and the WTI settle from FRED's keyless CSV (the St.
 *    Louis Fed — the same endpoint the 基本面 dimension already trusts);
 *  - daily FX fixes from open.er-api.com (keyless, refreshed daily);
 *  - spot gold from api.gold-api.com (keyless).
 *
 * All of it is end-of-day or daily-fix data, and none of it pretends
 * otherwise: every price carries the timestamp of when it actually printed,
 * so the freshness rule upstream (whoever printed most recently wins) will
 * only ever pick these when the live sources are dark — yesterday's real
 * close beating last Thursday's frozen one, never beating a live quote.
 * GER40 has no keyless third source (FRED's DAX series is discontinued);
 * it returns null here and keeps its two witnesses.
 */

export interface BackupPrice {
  price: number;
  /** When that price actually printed — never "now". */
  at: string;
  source: "fred" | "er-api" | "gold-api";
}

/** FRED series carrying an official daily close for the symbol. */
const FRED_CLOSE_SERIES: Partial<Record<SupportedSymbol, string>> = {
  NAS100: "NASDAQ100",
  US30: "DJIA",
  SPX500: "SP500",
  WTI: "DCOILWTICO",
};

/**
 * FRED stamps observations with the trading date only. The close itself
 * printed at 16:00 ET (20:00 or 21:00 UTC depending on DST); stamping the
 * early side means the price can read as slightly staler than it is, never
 * fresher — the safe direction for a freshness contest.
 */
const FRED_CLOSE_UTC = "T20:00:00Z";

async function fromFred(seriesId: string, gaps: string[]): Promise<BackupPrice | null> {
  const series = await fetchFredSeriesById(seriesId, gaps);
  if (!series) return null;
  const latest = [...series.points].reverse().find((p) => p.value !== null);
  if (!latest || latest.value === null) return null;
  return { price: latest.value, at: `${latest.date}${FRED_CLOSE_UTC}`, source: "fred" };
}

/** Which ER-API rate the symbol needs, and how to turn a USD-based rate into it. */
const ERAPI_PAIRS: Partial<Record<SupportedSymbol, { currency: string; invert: boolean }>> = {
  EURUSD: { currency: "EUR", invert: true },
  GBPUSD: { currency: "GBP", invert: true },
  USDJPY: { currency: "JPY", invert: false },
};

interface ErApiResponse {
  result?: string;
  time_last_update_unix?: number;
  rates?: Record<string, number>;
}

/** One call covers all three FX pairs; cached under a single key. */
async function fromErApi(
  pair: { currency: string; invert: boolean },
  gaps: string[],
): Promise<BackupPrice | null> {
  const result = await fetchFree<{ at: string; rates: Record<string, number> }>({
    source: "er-api",
    label: "ER-API 匯率 (USD 基準)",
    key: "erapi:usd",
    // The upstream refreshes once a day; a shorter TTL would only re-download
    // the same fix.
    ttlMs: 60 * 60 * 1000,
    limit: { perMinute: 10, perDay: 200 },
    gaps,
    staleMs: 24 * 60 * 60 * 1000,
    fn: async () => {
      const data = await fetchJson<ErApiResponse>("https://open.er-api.com/v6/latest/USD");
      if (data?.result !== "success" || !data.rates || !data.time_last_update_unix) return null;
      return { at: new Date(data.time_last_update_unix * 1000).toISOString(), rates: data.rates };
    },
  });
  if (!result) return null;
  const rate = result.value.rates[pair.currency];
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const price = pair.invert ? 1 / rate : rate;
  return { price: Number(price.toFixed(5)), at: result.value.at, source: "er-api" };
}

interface GoldApiResponse {
  price?: number;
  updatedAt?: string;
}

async function fromGoldApi(gaps: string[]): Promise<BackupPrice | null> {
  const result = await fetchFree<BackupPrice>({
    source: "gold-api",
    label: "gold-api 金價 (XAU)",
    key: "goldapi:xau",
    ttlMs: 10 * 60 * 1000,
    limit: { perMinute: 10, perDay: 500 },
    gaps,
    staleMs: 60 * 60 * 1000,
    fn: async () => {
      const data = await fetchJson<GoldApiResponse>("https://api.gold-api.com/price/XAU");
      const price = data?.price;
      // A price without a timestamp cannot enter a freshness contest — stamping
      // it "now" is exactly the carried-forward-bar lie this chain exists to
      // end. No parseable updatedAt, no price.
      const at = data?.updatedAt ? new Date(data.updatedAt) : null;
      if (!Number.isFinite(price) || (price as number) <= 0) return null;
      if (!at || Number.isNaN(at.getTime())) return null;
      return { price: price as number, at: at.toISOString(), source: "gold-api" };
    },
  });
  return result?.value ?? null;
}

/** `symbol` is a plain string so user-added targets can pass through; unknowns get null. */
export async function fetchBackupPrice(
  symbol: string,
  gaps: string[],
): Promise<BackupPrice | null> {
  const seriesId = FRED_CLOSE_SERIES[symbol as SupportedSymbol];
  if (seriesId) return fromFred(seriesId, gaps);
  const pair = ERAPI_PAIRS[symbol as SupportedSymbol];
  if (pair) return fromErApi(pair, gaps);
  if (symbol === "XAUUSD") return fromGoldApi(gaps);
  return null;
}

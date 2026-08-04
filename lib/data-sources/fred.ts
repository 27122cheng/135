import { cachedOrFetch, checkRateLimit } from "./cache";
import { fetchJson } from "./http";

export interface FredPoint {
  date: string;
  value: number | null;
}

export interface FredSeriesResult {
  label: FredLabel;
  seriesId: string;
  latest: FredPoint | null;
  /** Chronologically ordered, most recent ~30 observations. */
  points: FredPoint[];
}

export type FredLabel = "DXY" | "DGS10" | "DGS02" | "T10YIE" | "VIX";

/** FRED series IDs behind each macro label used across the six dimensions. */
const FRED_SERIES: Record<FredLabel, string> = {
  DXY: "DTWEXBGS", // Trade Weighted U.S. Dollar Index: Broad, Goods and Services (best public DXY proxy on FRED)
  DGS10: "DGS10", // 10-Year Treasury Constant Maturity Rate
  DGS02: "DGS2", // 2-Year Treasury Constant Maturity Rate
  T10YIE: "T10YIE", // 10-Year Breakeven Inflation Rate
  VIX: "VIXCLS", // CBOE Volatility Index
};

interface FredObservation {
  date: string;
  value: string;
}

interface FredApiResponse {
  observations?: FredObservation[];
}

export async function fetchFredSeries(
  label: FredLabel,
  gaps: string[],
): Promise<FredSeriesResult | null> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    gaps.push(`缺少 FRED_API_KEY，無法取得 ${label}`);
    return null;
  }
  if (!checkRateLimit("fred", 100000)) {
    gaps.push(`FRED API (${label}) 已達速率限制`);
    return null;
  }
  const seriesId = FRED_SERIES[label];
  const key = `fred:${seriesId}`;
  return cachedOrFetch(key, 30 * 60 * 1000, async () => {
    const url =
      `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}` +
      `&api_key=${apiKey}&file_type=json&sort_order=desc&limit=30`;
    const data = await fetchJson<FredApiResponse>(url);
    if (!data || !Array.isArray(data.observations) || data.observations.length === 0) {
      gaps.push(`FRED ${label} (${seriesId}) 回應為空`);
      return null;
    }
    const points: FredPoint[] = data.observations
      .map((o) => ({ date: o.date, value: o.value === "." ? null : Number(o.value) }))
      .reverse();
    const latest = [...points].reverse().find((p) => p.value !== null) ?? null;
    if (!latest) {
      gaps.push(`FRED ${label} (${seriesId}) 近期無有效數值`);
      return null;
    }
    return { label, seriesId, latest, points };
  });
}

export interface RealRateResult {
  value: number;
  asOf: string;
  dgs10: number;
  t10yie: number;
}

/** 實質利率 = 名目10年期公債殖利率(DGS10) - 10年期預期通膨(T10YIE) */
export async function fetchRealRate(gaps: string[]): Promise<RealRateResult | null> {
  const [dgs10, t10yie] = await Promise.all([
    fetchFredSeries("DGS10", gaps),
    fetchFredSeries("T10YIE", gaps),
  ]);
  if (!dgs10?.latest?.value || t10yie?.latest?.value == null) return null;
  return {
    value: dgs10.latest.value - t10yie.latest.value,
    asOf: dgs10.latest.date,
    dgs10: dgs10.latest.value,
    t10yie: t10yie.latest.value,
  };
}

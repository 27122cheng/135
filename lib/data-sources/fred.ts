import { getKey } from "../api-keys";
import { fetchFree } from "./free-source";
import { fetchJson, fetchText } from "./http";

/**
 * FRED documents 120 requests/minute. The keyless fredgraph.csv path used when
 * no key is set publishes no limit, so the same conservative budget covers both.
 */
const FRED_LIMIT = { perMinute: 100 };

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

export type FredLabel = "DXY" | "DGS10" | "DGS02" | "T10YIE" | "VIX" | "CRUDE_STOCKS";

/** FRED series IDs behind each macro label used across the six dimensions. */
const FRED_SERIES: Record<FredLabel, string> = {
  DXY: "DTWEXBGS", // Trade Weighted U.S. Dollar Index: Broad, Goods and Services (best public DXY proxy on FRED)
  DGS10: "DGS10", // 10-Year Treasury Constant Maturity Rate
  DGS02: "DGS2", // 2-Year Treasury Constant Maturity Rate
  T10YIE: "T10YIE", // 10-Year Breakeven Inflation Rate
  VIX: "VIXCLS", // CBOE Volatility Index
  CRUDE_STOCKS: "WCESTUS1", // Weekly U.S. Ending Stocks excl. SPR of Crude Oil (EIA data, mirrored by FRED)
};

interface FredObservation {
  date: string;
  value: string;
}

interface FredApiResponse {
  observations?: FredObservation[];
}

/**
 * FRED's graph-download endpoint serves the same observations as the API but
 * needs no key, which is what lets the whole 基本面 dimension work without the
 * user registering anything. FRED_API_KEY remains an optional upgrade path
 * (used first when present) rather than a requirement.
 *
 * Note: this keyless endpoint could not be reached from the build sandbox
 * (its egress allowlist blocks fred.stlouisfed.org), so the CSV shape below
 * is coded defensively — a header line plus `date,value` rows with "." for
 * missing values — and any parse mismatch falls through to data_gaps instead
 * of inventing numbers.
 */
async function fetchFredCsv(seriesId: string): Promise<FredPoint[] | null> {
  // ~400 days back is enough for 30 observations of even a weekly series.
  const start = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}&cosd=${start}`;
  const csv = await fetchText(url, { headers: { "User-Agent": "Mozilla/5.0" } }, 12000);
  if (!csv) return null;
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const points: FredPoint[] = [];
  for (const line of lines.slice(1)) {
    const [date, raw] = line.split(",");
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) continue;
    const trimmed = (raw ?? "").trim();
    const value = trimmed === "." || trimmed === "" ? null : Number(trimmed);
    points.push({ date: date.trim(), value: Number.isFinite(value as number) ? value : null });
  }
  return points.length > 0 ? points.slice(-30) : null;
}

/** Keyed JSON API — only used when FRED_API_KEY happens to be set. */
async function fetchFredApi(seriesId: string, apiKey: string): Promise<FredPoint[] | null> {
  const url =
    `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}` +
    `&api_key=${apiKey}&file_type=json&sort_order=desc&limit=30`;
  const data = await fetchJson<FredApiResponse>(url);
  if (!data || !Array.isArray(data.observations) || data.observations.length === 0) return null;
  return data.observations
    .map((o) => ({ date: o.date, value: o.value === "." ? null : Number(o.value) }))
    .reverse();
}

export async function fetchFredSeries(
  label: FredLabel,
  gaps: string[],
): Promise<FredSeriesResult | null> {
  const seriesId = FRED_SERIES[label];
  const result = await fetchFree<FredSeriesResult>({
    source: "fred",
    label: `FRED ${label} (${seriesId})`,
    key: `fred:${seriesId}`,
    ttlMs: 30 * 60 * 1000,
    limit: FRED_LIMIT,
    gaps,
    fn: async () => {
      const apiKey = getKey("FRED_API_KEY");
      const points =
        (apiKey ? await fetchFredApi(seriesId, apiKey) : null) ?? (await fetchFredCsv(seriesId));
      if (!points || points.length === 0) return null;
      const latest = [...points].reverse().find((p) => p.value !== null) ?? null;
      if (!latest) return null;
      return { label, seriesId, latest, points };
    },
  });
  return result?.value ?? null;
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

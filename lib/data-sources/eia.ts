import { getKey } from "../api-keys";
import { fetchFree } from "./free-source";

/** EIA's documented free tier. Only reached when EIA_API_KEY is set. */
const EIA_LIMIT = { perMinute: 60, perDay: 5000 };
import { fetchJson } from "./http";
import { fetchFredSeries } from "./fred";

export interface EiaInventoryPoint {
  period: string;
  value: number;
}

export interface EiaInventoryResult {
  latest: EiaInventoryPoint;
  previous: EiaInventoryPoint | null;
  source: "eia" | "fred";
}

interface EiaV2Response {
  response?: {
    data?: Array<{ period: string; value: number | string }>;
  };
}

/** Keyed EIA v2 API — only used when EIA_API_KEY happens to be set. */
async function fetchFromEia(apiKey: string, gaps: string[]): Promise<EiaInventoryResult | null> {
  const result = await fetchFree<EiaInventoryResult>({
    source: "eia",
    label: "EIA 原油庫存",
    key: "eia:crude:weekly",
    ttlMs: 60 * 60 * 1000,
    limit: EIA_LIMIT,
    gaps,
    fn: async () => {
    const url =
      `https://api.eia.gov/v2/petroleum/stoc/wstk/data/?api_key=${apiKey}` +
      `&frequency=weekly&data[0]=value&facets[series][]=WCESTUS1` +
      `&sort[0][column]=period&sort[0][direction]=desc&length=4`;
    const data = await fetchJson<EiaV2Response>(url);
    const rows = data?.response?.data;
    if (!Array.isArray(rows) || rows.length < 2) return null;
    const sorted = [...rows]
      .map((r) => ({ period: r.period, value: Number(r.value) }))
      .filter((r) => Number.isFinite(r.value))
      .sort((a, b) => b.period.localeCompare(a.period));
    if (sorted.length < 2) return null;
    return { latest: sorted[0], previous: sorted[1], source: "eia" as const };
    },
  });
  return result?.value ?? null;
}

/**
 * Weekly U.S. crude oil stocks. FRED mirrors the EIA series (WCESTUS1) and
 * needs no key, so EIA_API_KEY is an optional upgrade rather than a
 * requirement for the WTI 基本面 factor.
 */
export async function fetchEiaCrudeInventory(gaps: string[]): Promise<EiaInventoryResult | null> {
  const apiKey = getKey("EIA_API_KEY");
  if (apiKey) {
    const fromEia = await fetchFromEia(apiKey, gaps);
    if (fromEia) return fromEia;
  }

  const series = await fetchFredSeries("CRUDE_STOCKS", gaps);
  const valid = series?.points.filter((p): p is { date: string; value: number } => p.value !== null);
  if (!valid || valid.length < 2) {
    gaps.push("原油庫存資料取得失敗（EIA 與 FRED WCESTUS1 皆無可用資料）");
    return null;
  }
  return {
    latest: { period: valid.at(-1)!.date, value: valid.at(-1)!.value },
    previous: { period: valid.at(-2)!.date, value: valid.at(-2)!.value },
    source: "fred",
  };
}

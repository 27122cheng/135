import { cachedOrFetch } from "./cache";
import { fetchJson } from "./http";

export interface EiaInventoryPoint {
  period: string;
  value: number;
}

export interface EiaInventoryResult {
  latest: EiaInventoryPoint;
  previous: EiaInventoryPoint | null;
}

interface EiaV2Response {
  response?: {
    data?: Array<{ period: string; value: number | string }>;
  };
}

/**
 * EIA (U.S. Energy Information Administration) weekly crude oil stocks —
 * required by the WTI 基本面 breakdown in the spec but NOT in the Stage 1
 * approved API list; added in Stage 2 since it's a free/public API and
 * explicitly named for WTI. This sandbox's network policy blocks
 * api.eia.gov (only npm/PyPI/Anthropic/GitHub hosts are reachable here),
 * so the v2 route/facets below are coded from EIA's documented API shape
 * but were not live-verified during this build — fails safe to data_gaps
 * on any mismatch rather than fabricating a number.
 */
export async function fetchEiaCrudeInventory(gaps: string[]): Promise<EiaInventoryResult | null> {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) {
    gaps.push("缺少 EIA_API_KEY，無法取得 WTI 原油庫存");
    return null;
  }
  const key = "eia:crude:weekly";
  const result = await cachedOrFetch(key, 60 * 60 * 1000, async () => {
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
    return { latest: sorted[0], previous: sorted[1] };
  });
  if (!result) {
    gaps.push("EIA 原油庫存資料取得失敗或格式無法解析（此環境無法連線驗證來源格式）");
    return null;
  }
  return result;
}

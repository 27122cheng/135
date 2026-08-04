import { cachedOrFetch } from "./cache";
import { fetchJson } from "./http";

export interface CotReport {
  reportDate: string; // YYYY-MM-DD
  noncommercialLong: number;
  noncommercialShort: number;
  netNonCommercial: number;
  openInterest: number;
}

/** CFTC "Futures Only" legacy report contract codes, by our symbol. Gold (COMEX) only for Stage 1. */
const CFTC_CONTRACT_CODES: Partial<Record<string, string>> = {
  XAUUSD: "088691", // GOLD - COMMODITY EXCHANGE INC.
};

interface CftcRow {
  report_date_as_yyyy_mm_dd: string;
  noncomm_positions_long_all: string;
  noncomm_positions_short_all: string;
  open_interest_all: string;
}

/**
 * Weekly Commitments of Traders (legacy futures-only report, dataset 6dca-aqww)
 * via the CFTC's public Socrata API. No API key required for public reads.
 */
export async function fetchCotReport(symbol: string, gaps: string[]): Promise<CotReport[] | null> {
  const code = CFTC_CONTRACT_CODES[symbol];
  if (!code) {
    gaps.push(`尚未設定 ${symbol} 對應的 CFTC 合約代碼`);
    return null;
  }
  const key = `cftc:${code}`;
  const result = await cachedOrFetch(key, 6 * 60 * 60 * 1000, async () => {
    const where = encodeURIComponent(`cftc_contract_market_code='${code}'`);
    const url =
      `https://publicreporting.cftc.gov/resource/6dca-aqww.json?$where=${where}` +
      `&$order=report_date_as_yyyy_mm_dd DESC&$limit=60`;
    const data = await fetchJson<CftcRow[]>(url);
    if (!Array.isArray(data) || data.length === 0) return null;
    const reports = data
      .map((r) => {
        const long = Number(r.noncomm_positions_long_all);
        const short = Number(r.noncomm_positions_short_all);
        const oi = Number(r.open_interest_all);
        if (!r.report_date_as_yyyy_mm_dd || !Number.isFinite(long) || !Number.isFinite(short)) {
          return null;
        }
        return {
          reportDate: r.report_date_as_yyyy_mm_dd.slice(0, 10),
          noncommercialLong: long,
          noncommercialShort: short,
          netNonCommercial: long - short,
          openInterest: Number.isFinite(oi) ? oi : 0,
        };
      })
      .filter((r): r is CotReport => r !== null)
      .sort((a, b) => a.reportDate.localeCompare(b.reportDate));
    return reports.length > 0 ? reports : null;
  });
  if (!result) {
    gaps.push(`CFTC COT (${symbol}) 取得失敗或回應為空`);
    return null;
  }
  return result;
}

import { cachedOrFetch } from "./cache";
import { fetchJson } from "./http";

export interface CotReport {
  reportDate: string; // YYYY-MM-DD
  noncommercialLong: number;
  noncommercialShort: number;
  netNonCommercial: number;
  openInterest: number;
}

interface CftcRow {
  report_date_as_yyyy_mm_dd: string;
  noncomm_positions_long_all: string;
  noncomm_positions_short_all: string;
  open_interest_all: string;
}

/**
 * Weekly Commitments of Traders (legacy futures-only report, dataset 6dca-aqww)
 * via the CFTC's public Socrata API. No API key required for public reads.
 * `contractCode` comes from config/fundamentals.ts (null there means "no
 * CFTC data for this instrument", e.g. GER40/DAX trades on Eurex).
 */
export async function fetchCotReport(
  label: string,
  contractCode: string,
  gaps: string[],
): Promise<CotReport[] | null> {
  const key = `cftc:${contractCode}`;
  const result = await cachedOrFetch(key, 6 * 60 * 60 * 1000, async () => {
    const where = encodeURIComponent(`cftc_contract_market_code='${contractCode}'`);
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
    gaps.push(`CFTC COT (${label}) 取得失敗或回應為空`);
    return null;
  }
  return result;
}

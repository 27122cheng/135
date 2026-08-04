import { fetchFree } from "./free-source";

/**
 * Socrata throttles unauthenticated reads per IP but publishes no exact
 * number. COT updates once a week, so the 6h TTL means this budget is barely
 * touched in normal operation.
 */
const CFTC_LIMIT = { perMinute: 20, perDay: 500 };
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
  const result = await fetchFree<CotReport[]>({
    source: "cftc",
    label: `CFTC COT (${label})`,
    key: `cftc:${contractCode}`,
    ttlMs: 6 * 60 * 60 * 1000,
    limit: CFTC_LIMIT,
    gaps,
    fn: async () => {
    const where = encodeURIComponent(`cftc_contract_market_code='${contractCode}'`);
    const url =
      `https://publicreporting.cftc.gov/resource/6dca-aqww.json?$where=${where}` +
      // The space in "... DESC" has to be encoded; leaving it raw relies on the
      // fetch implementation to normalise it, which is not something to bet on.
      `&$order=${encodeURIComponent("report_date_as_yyyy_mm_dd DESC")}&$limit=60`;
    // 20s, not the 6s default: a filtered Socrata query over the full COT
    // history routinely takes longer than 6s from a cold cache, and timing out
    // was being recorded as a source failure — which then tripped the backoff
    // and suppressed the next few attempts too.
    const data = await fetchJson<CftcRow[]>(url, undefined, 20000);
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
    },
  });
  return result?.value ?? null;
}

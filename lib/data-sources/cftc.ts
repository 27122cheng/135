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
  /** Present when several candidate codes were queried at once. */
  cftc_contract_market_code?: string;
}

/**
 * Weekly Commitments of Traders (legacy futures-only report, dataset 6dca-aqww)
 * via the CFTC's public Socrata API. No API key required for public reads.
 * `contractCode` comes from config/fundamentals.ts (null there means "no
 * CFTC data for this instrument", e.g. GER40/DAX trades on Eurex).
 */
export async function fetchCotReport(
  label: string,
  /**
   * One code, or several candidates for the same instrument.
   *
   * The CFTC publishes the same underlying under more than one contract market
   * code — a futures-only series and a consolidated one, sometimes a legacy
   * code alongside a current one — and which of them carries rows is not
   * something the docs make obvious. NAS100 was configured with `20974P` and
   * came back 查無資料 on every run for weeks; the futures-only `209742` has
   * the data. Candidates are queried in one request rather than in sequence,
   * so trying three costs the same as trying one.
   */
  contractCode: string | string[],
  gaps: string[],
): Promise<CotReport[] | null> {
  const codes = (Array.isArray(contractCode) ? contractCode : [contractCode]).filter(Boolean);
  if (codes.length === 0) return null;
  // Set when the request succeeded but the contract code matched nothing. That
  // is a *configuration* fact, not a transport failure, and the difference
  // matters twice over: retrying can never fix it, and letting it count as a
  // failure trips the shared `cftc` backoff — so one unverified contract code
  // silently blocked the COT lookup for every other symbol in the same sweep.
  let emptyMatch = false;

  const result = await fetchFree<CotReport[]>({
    source: "cftc",
    label: `CFTC COT (${label})`,
    key: `cftc:${codes.join("|")}`,
    ttlMs: 6 * 60 * 60 * 1000,
    limit: CFTC_LIMIT,
    gaps,
    diagnose: () =>
      emptyMatch
        ? `合約代碼 ${codes.join(" / ")} 全部查無資料，代碼可能有誤（見 config/fundamentals.ts），重試無用`
        : null,
    wasTransportFailure: () => !emptyMatch,
    fn: async () => {
    const inList = codes.map((c) => `'${c.replace(/'/g, "''")}'`).join(",");
    const where = encodeURIComponent(`cftc_contract_market_code in (${inList})`);
    const url =
      `https://publicreporting.cftc.gov/resource/6dca-aqww.json?$where=${where}` +
      // The space in "... DESC" has to be encoded; leaving it raw relies on the
      // fetch implementation to normalise it, which is not something to bet on.
      // Enough rows that a multi-code query still returns a full 52-week window
      // for whichever code actually has one.
      `&$order=${encodeURIComponent("report_date_as_yyyy_mm_dd DESC")}&$limit=${60 * codes.length}`;
    // 20s, not the 6s default: a filtered Socrata query over the full COT
    // history routinely takes longer than 6s from a cold cache, and timing out
    // was being recorded as a source failure — which then tripped the backoff
    // and suppressed the next few attempts too.
    const data = await fetchJson<CftcRow[]>(url, undefined, 20000);
    if (!Array.isArray(data)) return null;
    if (data.length === 0) {
      // Socrata answered; the filter just matched nothing.
      emptyMatch = true;
      return null;
    }
    // With several candidate codes the response interleaves them. Keep the one
    // that actually has a series — most rows, then most recent — rather than
    // mixing two different contracts' positions into one time series.
    const byCode = new Map<string, CftcRow[]>();
    for (const row of data) {
      const code = String(row.cftc_contract_market_code ?? codes[0]);
      const list = byCode.get(code);
      if (list) list.push(row);
      else byCode.set(code, [row]);
    }
    const richest = [...byCode.values()].reduce((best, rows) =>
      rows.length > best.length ? rows : best,
    );

    const reports = richest
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

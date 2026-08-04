import type { YieldLegSource } from "@/config/rate-spreads";
import { fetchFree } from "./free-source";
import { fetchText } from "./http";
import { fetchFredSeries } from "./fred";

/**
 * Daily government bond yields, keyless.
 *
 * FRED's approved list only covers US Treasuries, and its foreign series
 * (OECD IRLTLT01) are monthly and partly discontinued — a monthly number can't
 * drive a trading signal. So foreign legs come from Stooq's daily CSV, with the
 * relevant central bank's own SDMX endpoint as the fallback.
 *
 * Every source here is end-of-day: the latest point can legitimately be one or
 * two trading days behind. That's why callers get the `as_of` date and must
 * decide whether it is fresh enough — see lib/analysis/rate-spread.ts. Nothing
 * in this file interpolates or carries a previous value forward.
 */

export interface YieldPoint {
  date: string; // YYYY-MM-DD
  /** Percent, e.g. 4.21 for 4.21%. */
  value: number;
}

export interface YieldSeries {
  label: string;
  /** Chronological, oldest first. */
  points: YieldPoint[];
  source: "stooq" | "ecb" | "fred";
}

/** Yields move slowly and are published once a day; 6h per the spec. */
export const YIELD_TTL_MS = 6 * 60 * 60 * 1000;

/** Self-imposed — Stooq publishes no limit for the CSV download. */
const STOOQ_LIMIT = { perMinute: 30, perDay: 1000 };
const ECB_LIMIT = { perMinute: 30, perDay: 1000 };

function parseStooqCsv(csv: string): YieldPoint[] {
  const points: YieldPoint[] = [];
  for (const line of csv.trim().split(/\r?\n/).slice(1)) {
    // Date,Open,High,Low,Close[,Volume] — the close is the published yield.
    const [date, , , , close] = line.split(",");
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const value = Number(close);
    if (!Number.isFinite(value)) continue;
    points.push({ date, value });
  }
  return points.sort((a, b) => a.date.localeCompare(b.date));
}

async function fromStooq(code: string, label: string, gaps: string[]): Promise<YieldSeries | null> {
  const result = await fetchFree<YieldPoint[]>({
    source: "stooq",
    label: `Stooq 殖利率 (${label})`,
    key: `stooq:yield:${code}`,
    ttlMs: YIELD_TTL_MS,
    limit: STOOQ_LIMIT,
    gaps,
    fn: async () => {
      const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(code)}&i=d`;
      const csv = await fetchText(url, { headers: { "User-Agent": "Mozilla/5.0" } }, 12000);
      // An HTML body is an error page; an unknown ticker yields no rows.
      if (!csv || csv.trim().startsWith("<")) return null;
      const points = parseStooqCsv(csv);
      return points.length > 0 ? points : null;
    },
  });
  return result ? { label, points: result.value, source: "stooq" } : null;
}

/**
 * ECB Data Portal. Asked for `format=csvdata` rather than SDMX-ML: the CSV is
 * a flat table this can parse in a dozen lines, where the XML would need a
 * real parser for no extra information.
 */
async function fromEcb(key: string, label: string, gaps: string[]): Promise<YieldSeries | null> {
  const result = await fetchFree<YieldPoint[]>({
    source: "ecb",
    label: `ECB 殖利率曲線 (${label})`,
    key: `ecb:${key}`,
    ttlMs: YIELD_TTL_MS,
    limit: ECB_LIMIT,
    gaps,
    fn: async () => {
      const url =
        `https://data-api.ecb.europa.eu/service/data/${key}` +
        `?format=csvdata&lastNObservations=120&detail=dataonly`;
      const csv = await fetchText(url, { headers: { accept: "text/csv" } }, 15000);
      if (!csv || csv.trim().startsWith("<")) return null;

      const lines = csv.trim().split(/\r?\n/);
      if (lines.length < 2) return null;
      // Column order isn't guaranteed, so locate them by header name.
      const header = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
      const dateIdx = header.indexOf("TIME_PERIOD");
      const valueIdx = header.indexOf("OBS_VALUE");
      if (dateIdx < 0 || valueIdx < 0) return null;

      const points: YieldPoint[] = [];
      for (const line of lines.slice(1)) {
        const cells = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
        const date = cells[dateIdx];
        const value = Number(cells[valueIdx]);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") || !Number.isFinite(value)) continue;
        points.push({ date, value });
      }
      return points.length > 0 ? points.sort((a, b) => a.date.localeCompare(b.date)) : null;
    },
  });
  return result ? { label, points: result.value, source: "ecb" } : null;
}

async function fromFred(
  leg: YieldLegSource,
  gaps: string[],
): Promise<YieldSeries | null> {
  if (!leg.fredLabel) return null;
  const series = await fetchFredSeries(leg.fredLabel, gaps);
  if (!series) return null;
  const points = series.points
    .filter((p): p is { date: string; value: number } => p.value !== null)
    .map((p) => ({ date: p.date, value: p.value }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return points.length > 0 ? { label: leg.label, points, source: "fred" } : null;
}

/**
 * Tries each configured source in order and returns the first that answers.
 * Individual failures are collected locally and only surfaced if every source
 * fails — a working fallback shouldn't report a gap.
 */
export async function fetchYieldSeries(
  leg: YieldLegSource,
  gaps: string[],
): Promise<YieldSeries | null> {
  const attempts: string[] = [];

  // FRED first for US legs: it is the authoritative source and the one this
  // project has actually verified against a live response.
  if (leg.fredLabel) {
    const local: string[] = [];
    const fred = await fromFred(leg, local);
    if (fred) return fred;
    attempts.push(...local);
  }

  if (leg.stooqCode) {
    const local: string[] = [];
    const stooq = await fromStooq(leg.stooqCode, leg.label, local);
    if (stooq) return stooq;
    attempts.push(...local);
  }

  if (leg.ecbKey) {
    const local: string[] = [];
    const ecb = await fromEcb(leg.ecbKey, leg.label, local);
    if (ecb) return ecb;
    attempts.push(...local);
  }

  gaps.push(`${leg.label} 殖利率所有來源皆取得失敗（${attempts.join("；") || "無可用來源設定"}）`);
  return null;
}

import { fetchFree } from "./free-source";
import { fetchJson } from "./http";

/**
 * DBnomics — one keyless API in front of 90+ statistical agencies (IMF, BIS,
 * ECB, OECD, World Bank, and most national central banks).
 *
 * Doing this first is what avoids writing an SDMX parser per institution:
 * DBnomics has already normalised every provider onto the same JSON shape, so
 * IMF IFS monetary gold holdings and a national central bank's reserve series
 * come back looking identical. Only sources DBnomics does not carry (Swiss
 * customs, SGE, Hong Kong statistics) justify a bespoke scraper.
 *
 * No authentication, no key, no registration.
 */

const BASE = "https://api.db.nomics.world/v22";

/** Self-imposed. DBnomics publishes no hard limit but asks for reasonable use. */
const DBNOMICS_LIMIT = { perMinute: 30, perDay: 1000 };

/** Macro series update daily at most; many are monthly. */
export const DBNOMICS_TTL_MS = 6 * 60 * 60 * 1000;

export interface SeriesPoint {
  /** Period as published: "2026-08", "2026-Q2", or "2026-08-04". */
  period: string;
  value: number;
}

export interface DbnomicsSeries {
  seriesId: string;
  name: string;
  /** Chronological, oldest first, missing observations dropped. */
  points: SeriesPoint[];
}

interface RawSeriesResponse {
  series?: {
    docs?: Array<{
      series_code?: string;
      series_name?: string;
      period?: string[];
      // DBnomics uses "NA" for a missing observation rather than null.
      value?: Array<number | string | null>;
    }>;
  };
}

/**
 * Fetches one series by its full `provider/dataset/series` id.
 *
 * Returns null for an unknown id rather than throwing — the series codes in
 * config/gold-fundamentals.ts could not be verified live from the build
 * sandbox, so a wrong one has to degrade into "this factor is unavailable"
 * instead of taking down the whole 基本面 dimension.
 */
export async function fetchDbnomicsSeries(
  seriesId: string,
  gaps: string[],
): Promise<DbnomicsSeries | null> {
  const result = await fetchFree<DbnomicsSeries>({
    source: "dbnomics",
    label: `DBnomics ${seriesId}`,
    key: `dbnomics:${seriesId}`,
    ttlMs: DBNOMICS_TTL_MS,
    limit: DBNOMICS_LIMIT,
    gaps,
    fn: async () => {
      const url = `${BASE}/series/${seriesId}?observations=1`;
      const data = await fetchJson<RawSeriesResponse>(url, undefined, 20000);
      const doc = data?.series?.docs?.[0];
      if (!doc || !Array.isArray(doc.period) || !Array.isArray(doc.value)) return null;

      const points: SeriesPoint[] = [];
      for (let i = 0; i < doc.period.length; i++) {
        const period = doc.period[i];
        const raw = doc.value[i];
        // "NA" and null are genuinely missing. Skipping them is the only
        // correct move — carrying the previous value forward would invent an
        // observation, which the spec forbids elsewhere for the same reason.
        if (typeof period !== "string") continue;
        const value = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isFinite(value)) continue;
        points.push({ period, value });
      }
      if (points.length === 0) return null;

      points.sort((a, b) => a.period.localeCompare(b.period));
      return { seriesId, name: doc.series_name ?? seriesId, points };
    },
  });
  return result?.value ?? null;
}

export interface SearchHit {
  seriesId: string;
  name: string;
  provider: string;
  dataset: string;
}

/**
 * Search, used by /api/proxy/dbnomics so the series ids in the config can be
 * discovered and corrected without guessing. Not called by the analysis path.
 */
export async function searchDbnomics(query: string, gaps: string[]): Promise<SearchHit[] | null> {
  const result = await fetchFree<SearchHit[]>({
    source: "dbnomics",
    label: `DBnomics 搜尋 (${query})`,
    key: `dbnomics:search:${query}`,
    ttlMs: DBNOMICS_TTL_MS,
    limit: DBNOMICS_LIMIT,
    gaps,
    fn: async () => {
      const url = `${BASE}/search?q=${encodeURIComponent(query)}&limit=20`;
      const data = await fetchJson<{
        results?: {
          docs?: Array<{
            code?: string;
            name?: string;
            provider_code?: string;
            dataset_code?: string;
          }>;
        };
      }>(url, undefined, 20000);
      const docs = data?.results?.docs;
      if (!Array.isArray(docs)) return null;
      const hits = docs
        .filter((d) => d.provider_code && d.dataset_code && d.code)
        .map((d) => ({
          seriesId: `${d.provider_code}/${d.dataset_code}/${d.code}`,
          name: d.name ?? d.code ?? "",
          provider: d.provider_code ?? "",
          dataset: d.dataset_code ?? "",
        }));
      return hits.length > 0 ? hits : null;
    },
  });
  return result?.value ?? null;
}

/**
 * The cadence a series actually publishes at, read off its own periods.
 *
 * Needed because a source's declared frequency is a statement of intent and can
 * be wrong: 印度 RBI was configured as weekly while DBnomics returns monthly
 * observations, so it was judged against a 21-day staleness limit it could
 * never meet and was disabled on every run. What the series does beats what the
 * config claims.
 *
 * Returns null when the periods are mixed or unrecognised, in which case the
 * caller should fall back to the declared frequency.
 */
export function inferFrequency(
  points: SeriesPoint[],
): "daily" | "weekly" | "monthly" | "quarterly" | "yearly" | null {
  const recent = points.slice(-8).map((p) => p.period);
  if (recent.length < 2) return null;

  if (recent.every((p) => /^\d{4}-\d{2}$/.test(p))) return "monthly";
  if (recent.every((p) => /^\d{4}-Q[1-4]$/i.test(p))) return "quarterly";
  if (recent.every((p) => /^\d{4}$/.test(p))) return "yearly";
  if (!recent.every((p) => /^\d{4}-\d{2}-\d{2}$/.test(p))) return null;

  // Daily-stamped periods can still be weekly or monthly snapshots, so the
  // spacing decides. Median, not mean: one gap over a holiday shouldn't
  // reclassify a whole series.
  const gaps: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const a = periodEndDate(recent[i - 1]);
    const b = periodEndDate(recent[i]);
    if (a && b) gaps.push((b.getTime() - a.getTime()) / 86_400_000);
  }
  if (gaps.length === 0) return null;
  gaps.sort((x, y) => x - y);
  const median = gaps[Math.floor(gaps.length / 2)];
  if (median <= 3) return "daily";
  if (median <= 10) return "weekly";
  if (median <= 45) return "monthly";
  if (median <= 120) return "quarterly";
  return "yearly";
}

/**
 * Converts a DBnomics period to the last calendar day it covers.
 *
 * Freshness has to be judged against the end of the period, not its label: a
 * monthly observation stamped "2026-07" is not 31 days stale on 1 August, it
 * is one day past the period it describes.
 */
export function periodEndDate(period: string): Date | null {
  const daily = period.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (daily) return new Date(Date.UTC(+daily[1], +daily[2] - 1, +daily[3]));

  const monthly = period.match(/^(\d{4})-(\d{2})$/);
  if (monthly) return new Date(Date.UTC(+monthly[1], +monthly[2], 0));

  const quarterly = period.match(/^(\d{4})-Q([1-4])$/i);
  if (quarterly) return new Date(Date.UTC(+quarterly[1], +quarterly[2] * 3, 0));

  const yearly = period.match(/^(\d{4})$/);
  if (yearly) return new Date(Date.UTC(+yearly[1], 12, 0));

  return null;
}

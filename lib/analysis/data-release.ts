import type { BiasItem, CommodityMeta } from "@/types/signal";
import type { FundamentalsConfig } from "@/config/fundamentals";
import {
  TRACKED_RELEASES,
  directionFromUsd,
  releaseBySeriesId,
  type TrackedRelease,
} from "@/config/data-releases";
import { fetchFredSeriesById, type FredPoint } from "../data-sources/fred";
import { fetchEconomicCalendar, type EconomicEvent } from "../data-sources/finnhub";
import { getSignalStore, type StoredRelease } from "../db";

/**
 * 即時數據公布 → 基本面 BiasItems.
 *
 * Two halves that must not be confused with each other:
 *
 *  - **Detection** (`ingestReleases`) asks "has a new print appeared since the
 *    last time anyone looked". FRED serves observations without publication
 *    timestamps, so the only honest answer is "the first scan that saw it",
 *    which the `data_release` table records once and never rewrites.
 *  - **Scoring** (`analyzeDataReleases`) turns prints first seen inside their
 *    impact window into factors. It reads the table; it never re-derives
 *    freshness from the observation label, because a CPI *labelled* 2026-07-01
 *    can land on any day in August and the label says nothing about when the
 *    market found out.
 *
 * A deployment with no database can do neither, and reports that rather than
 * guessing — "the newest observation is probably new" would fire a fresh CPI
 * factor on every single scan for a month.
 */

/** How far back the scoring pass looks; individual releases expire sooner. */
const LOOKBACK_HOURS = 72;

export interface ReleaseIngestResult {
  /** Prints seen for the first time in this run — the ones worth announcing. */
  fresh: Array<{ release: TrackedRelease; value: number; previous: number | null; period: string }>;
  gaps: string[];
}

type Observed = { date: string; value: number };

function lastTwo(points: FredPoint[]): { latest: Observed; previous: Observed | null } | null {
  const valid = points.filter((p): p is Observed => p.value !== null);
  if (valid.length === 0) return null;
  return { latest: valid[valid.length - 1], previous: valid[valid.length - 2] ?? null };
}

/** Matches a calendar row to a tracked release so its consensus can be used. */
export function findEstimate(
  release: TrackedRelease,
  events: EconomicEvent[] | null,
): number | null {
  if (!events) return null;
  for (const event of events) {
    // US releases only — the config's transmission channel is the dollar, and
    // a euro-area CPI print reaching a US series would be plainly wrong.
    if (event.country && !/^(us|united states)$/i.test(event.country)) continue;
    const name = event.event.toLowerCase();
    if (!release.calendarAliases.some((alias) => name.includes(alias))) continue;
    if (typeof event.estimate === "number" && Number.isFinite(event.estimate)) {
      return event.estimate;
    }
  }
  return null;
}

/**
 * Fetches every tracked series and records any print not seen before.
 *
 * Called from the refresh and from the 5-minute monitor. Both can safely race:
 * `recordRelease` reports "new" only to whichever call actually inserted the
 * row, so a CPI print is announced exactly once no matter how many schedulers
 * happen to notice it in the same minute.
 */
export async function ingestReleases(gaps: string[]): Promise<ReleaseIngestResult> {
  const store = getSignalStore();
  if (!store) {
    return {
      fresh: [],
      gaps: ["未設定資料庫，無法判斷數據是否為新公布，本階段不納入數據公布因子"],
    };
  }

  const calendar = await fetchEconomicCalendar(gaps);

  const results = await Promise.all(
    TRACKED_RELEASES.map(async (release) => {
      const series = await fetchFredSeriesById(release.seriesId, gaps);
      if (!series) return null;
      const pair = lastTwo(series.points);
      if (!pair) return null;

      const { isNew } = await store.recordRelease({
        seriesId: release.seriesId,
        period: pair.latest.date,
        value: pair.latest.value,
        previousValue: pair.previous?.value ?? null,
        estimate: findEstimate(release, calendar),
      });

      return isNew
        ? {
            release,
            value: pair.latest.value,
            previous: pair.previous?.value ?? null,
            period: pair.latest.date,
          }
        : null;
    }),
  );

  return { fresh: results.filter((r): r is NonNullable<typeof r> => r !== null), gaps: [] };
}

interface Comparison {
  baseline: number;
  /** What the baseline is, for the evidence string. */
  basis: "市場預期" | "前值";
  changePct: number;
}

/**
 * Compares a print to whichever baseline is available.
 *
 * Consensus is the right comparison and the one the market trades, so it wins
 * whenever a calendar supplied it. Falling back to the previous print is a
 * genuinely different statement — "inflation rose" is not "inflation beat" —
 * and `basis` carries that distinction all the way into the evidence text
 * rather than letting the number imply a surprise that was never measured.
 */
export function compare(stored: StoredRelease): Comparison | null {
  const baseline = stored.estimate ?? stored.previousValue;
  if (baseline === null || !Number.isFinite(baseline)) return null;
  if (Math.abs(baseline) === 0) return null;
  return {
    baseline,
    basis: stored.estimate !== null ? "市場預期" : "前值",
    changePct: ((stored.value - baseline) / Math.abs(baseline)) * 100,
  };
}

/** Hours between a release being first seen and `now`. */
export function hoursSince(firstSeenAt: string, now: Date): number {
  const seen = new Date(firstSeenAt).getTime();
  if (!Number.isFinite(seen)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - seen) / 3600_000;
}

/**
 * Turns one stored print into a factor for one symbol, or explains the refusal.
 *
 * Exported for tests: the expiry window and the direction mapping are the two
 * rules that must not drift, and both are pure arithmetic.
 */
export function buildReleaseItem(
  stored: StoredRelease,
  meta: CommodityMeta,
  config: FundamentalsConfig,
  now: Date = new Date(),
): BiasItem | null {
  const release = releaseBySeriesId(stored.seriesId);
  if (!release) return null;

  const age = hoursSince(stored.firstSeenAt, now);
  // Outside the window the print is history, not an event. Dropped entirely
  // rather than faded: a half-weighted three-day-old CPI is indistinguishable
  // from noise in the total, but still moves the grade.
  if (age > release.impactHours) return null;

  const comparison = compare(stored);
  if (!comparison) return null;

  const significant = Math.abs(comparison.changePct) >= release.minChangePct;
  // A hotter print pushes the dollar the way the release declares; a cooler one
  // pushes it the other way.
  const usdImpact = comparison.changePct > 0
    ? release.usdImpact
    : release.usdImpact === "stronger"
      ? "weaker"
      : "stronger";

  const direction = significant ? directionFromUsd(usdImpact, config.dxyInverted) : "neutral";
  const weight = significant ? release.weight : 0;

  const hotter = comparison.changePct > 0;
  return {
    dimension: "基本面",
    factor:
      `${release.label} 公布 ${round(stored.value)}` +
      `（${comparison.basis} ${round(comparison.baseline)}，${hotter ? "高於" : "低於"}${comparison.basis}` +
      `${round(Math.abs(comparison.changePct))}%）` +
      (significant ? `，美元偏${usdImpact === "stronger" ? "強" : "弱"}` : "，幅度未達門檻"),
    direction,
    weight,
    evidence:
      `期間 ${stored.period}，公布後 ${age < 1 ? "不到 1" : Math.floor(age)} 小時` +
      `（影響窗 ${release.impactHours} 小時）` +
      (comparison.basis === "前值"
        ? "。無市場預期可比，此為與前值比較，不代表優於／劣於預期"
        : "") +
      (significant ? "" : `。變化未達 ${release.minChangePct}% 門檻，不計方向`),
    source: `FRED ${stored.seriesId}（${release.note}）`,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Every tracked print still inside its impact window, as factors for `meta`.
 *
 * One item per release rather than a combined "數據面" score: two prints
 * pulling opposite ways is information, and summing them into a single net
 * number would hide it.
 */
export async function analyzeDataReleases(
  meta: CommodityMeta,
  config: FundamentalsConfig,
  gaps: string[],
): Promise<BiasItem[]> {
  const store = getSignalStore();
  if (!store) return [];

  let recent: StoredRelease[];
  try {
    recent = await store.recentReleases(LOOKBACK_HOURS);
  } catch (err) {
    gaps.push(`讀取數據公布紀錄失敗：${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const now = new Date();
  return recent
    .map((stored) => buildReleaseItem(stored, meta, config, now))
    .filter((item): item is BiasItem => item !== null);
}

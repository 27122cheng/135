/**
 * 央行購金與黃金實體流向 — sources, frequency tiers and weight ceilings.
 *
 * The tiering is the point. A monthly PBoC reserve print and a daily GLD
 * holdings change are not the same kind of evidence: one tells you what a
 * central bank did five weeks ago, the other what money did yesterday. Giving
 * them equal weight would let a stale monthly number outvote today's flow.
 *
 * Hard rules from the spec, encoded here:
 *  - **Weight ceiling by frequency**: daily ≤2, weekly ≤2, monthly ≤1,
 *    quarterly/annual = 0 (chart context only, never scored).
 *  - **Every source declares `releaseLagDays`**, and a factor whose latest
 *    observation is older than its frequency plus that lag is dropped rather
 *    than presented as current.
 *  - **Never sum different frequencies into one BiasItem.** Each source
 *    produces its own item, so a monthly and a daily reading can never be
 *    added together — see lib/analysis/gold-flows.ts.
 */

export type SourceFrequency = "daily" | "weekly" | "monthly" | "quarterly";

/** 權重上限，依頻率分層. Quarterly is deliberately 0 — background, not a vote. */
export const FREQUENCY_WEIGHT_CAP: Record<SourceFrequency, 0 | 1 | 2> = {
  daily: 2,
  weekly: 2,
  monthly: 1,
  quarterly: 0,
};

/** Nominal length of one period, used to judge whether a print is overdue. */
export const FREQUENCY_DAYS: Record<SourceFrequency, number> = {
  daily: 1,
  weekly: 7,
  monthly: 31,
  quarterly: 92,
};

export interface GoldFlowSource {
  id: string;
  label: string;
  frequency: SourceFrequency;
  /**
   * DBnomics `provider/dataset/series`.
   *
   * **These ids are unverified.** The build sandbox cannot reach
   * api.db.nomics.world, so they are written from the providers' documented
   * dataset naming and must be confirmed against a live response. A wrong id
   * returns nothing and the factor is skipped with a data_gap — it never
   * produces a wrong number. Use `/api/proxy/dbnomics?search=...` to find the
   * real code and correct the entry.
   */
  series: string;
  /** Typical days between period end and publication. */
  releaseLagDays: number;
  /**
   * Which way a *rising* series points for gold.
   * Central banks buying and physical imports rising are both bullish.
   */
  risingMeans: "long" | "short";
  /** How many observations back the change is measured over. */
  lookback: number;
  /** Change smaller than this (in %) is noise, not a signal. */
  minChangePct: number;
  note: string;
}

/**
 * Sources DBnomics carries. Ordered by signal value: physical flow first
 * (it leads), then national central banks (they publish before the IMF
 * aggregate), then the IMF roll-up.
 */
export const DBNOMICS_GOLD_SOURCES: GoldFlowSource[] = [
  {
    id: "pboc-reserves",
    label: "中國人民銀行 官方黃金儲備",
    frequency: "monthly",
    // PBoC publishes around the 7th; the market watches this one most.
    series: "IMF/IFS/M.CN.RAFAGOLDV_OZT",
    releaseLagDays: 7,
    risingMeans: "long",
    lookback: 3,
    minChangePct: 0.1,
    note: "每月約 7 日公布，市場最看重的央行購金指標",
  },
  {
    id: "rbi-reserves",
    label: "印度 RBI 黃金儲備",
    frequency: "weekly",
    series: "IMF/IFS/M.IN.RAFAGOLDV_OZT",
    releaseLagDays: 7,
    risingMeans: "long",
    lookback: 4,
    minChangePct: 0.1,
    note: "RBI 週度統計補充，頻率高於多數央行",
  },
  {
    id: "tcmb-reserves",
    label: "土耳其 TCMB 黃金儲備",
    frequency: "weekly",
    series: "IMF/IFS/M.TR.RAFAGOLDV_OZT",
    releaseLagDays: 7,
    risingMeans: "long",
    lookback: 4,
    minChangePct: 0.2,
    note: "土耳其是近年主要買家之一",
  },
  {
    id: "cbr-reserves",
    label: "俄羅斯央行 黃金儲備",
    frequency: "monthly",
    series: "IMF/IFS/M.RU.RAFAGOLDV_OZT",
    releaseLagDays: 20,
    risingMeans: "long",
    lookback: 3,
    minChangePct: 0.1,
    note: "CBR 國際儲備月報",
  },
  {
    id: "world-official-reserves",
    label: "IMF 全球官方黃金儲備",
    frequency: "monthly",
    series: "IMF/IFS/M.W00.RAFAGOLDV_OZT",
    releaseLagDays: 45,
    risingMeans: "long",
    lookback: 3,
    minChangePct: 0.05,
    note: "IMF IFS 彙總，公布最慢但涵蓋最廣",
  },
];

/**
 * Sources DBnomics does not carry. Listed so the gap is explicit rather than
 * silently absent, and so anyone extending this knows exactly which ones
 * justify a bespoke scraper — the spec's rule is that only these do.
 */
export const SCRAPER_ONLY_SOURCES = [
  { label: "瑞士海關 Swiss-Impex 黃金進出口", frequency: "monthly" as const },
  { label: "上海黃金交易所 SGE 出庫量", frequency: "monthly" as const },
  { label: "香港政府統計處 對中國大陸黃金淨出口", frequency: "monthly" as const },
  { label: "英國 HMRC 倫敦金庫進出流向", frequency: "monthly" as const },
  { label: "LBMA 倫敦金庫每月庫存", frequency: "monthly" as const },
];

/**
 * Maximum age of the latest observation before a factor is dropped.
 * One period plus its publication lag, plus a few days of slack for holidays
 * and irregular release calendars.
 */
export function maxAgeDays(source: GoldFlowSource): number {
  return FREQUENCY_DAYS[source.frequency] + source.releaseLagDays + 7;
}

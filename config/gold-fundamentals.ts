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

export type SourceFrequency = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";

/** 權重上限，依頻率分層. Quarterly and slower are deliberately 0 — background, not a vote. */
export const FREQUENCY_WEIGHT_CAP: Record<SourceFrequency, 0 | 1 | 2> = {
  daily: 2,
  weekly: 2,
  monthly: 1,
  quarterly: 0,
  yearly: 0,
};

/** Nominal length of one period, used to judge whether a print is overdue. */
export const FREQUENCY_DAYS: Record<SourceFrequency, number> = {
  daily: 1,
  weekly: 7,
  monthly: 31,
  quarterly: 92,
  yearly: 366,
};

/** Coarser of two tiers — used to take the more conservative weight ceiling. */
const TIER_ORDER: SourceFrequency[] = ["daily", "weekly", "monthly", "quarterly", "yearly"];
export function coarser(a: SourceFrequency, b: SourceFrequency): SourceFrequency {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}

export interface GoldFlowSource {
  id: string;
  label: string;
  /**
   * The frequency this source is *expected* to publish at. It caps the weight,
   * but it does not decide the staleness limit — that comes from the periods
   * the series actually returns. A source declared weekly whose data turns out
   * to be monthly was being judged against a 21-day clock and disabled every
   * single run; the data's own cadence is the only honest yardstick.
   */
  frequency: SourceFrequency;
  /**
   * DBnomics `provider/dataset/series` candidates, tried in order. The first
   * one that both resolves **and** is fresh wins.
   *
   * A list rather than a single id because these codes cannot be verified from
   * the build sandbox (no network), and because a dataset that goes dormant
   * looks exactly like a correct id — IMF/IFS resolved fine while sitting 400
   * days behind. One dead code should cost a factor its best source, not its
   * existence. All candidates failing is still fail-safe: the factor is skipped
   * with a data_gap, never filled with a stale or invented number.
   *
   * Use `/api/proxy/dbnomics` to see which candidate each source resolved to
   * and how fresh it is, and `?search=` to find a replacement.
   */
  series: string[];
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
 *
 * IRFCL (International Reserves and Foreign Currency Liquidity) is listed
 * ahead of IFS everywhere: it is the monthly template countries report reserves
 * on, so it lands weeks earlier than the IFS roll-up of the same numbers.
 */
export const DBNOMICS_GOLD_SOURCES: GoldFlowSource[] = [
  {
    id: "pboc-reserves",
    label: "中國人民銀行 官方黃金儲備",
    frequency: "monthly",
    // PBoC publishes around the 7th; the market watches this one most.
    series: [
      "IMF/IRFCL/M.CN.RAFAGOLDV_OZT",
      "IMF/IFS/M.CN.RAFAGOLDV_OZT",
      "IMF/IRFCL/M.CN.RAFAGOLD_USD",
    ],
    releaseLagDays: 7,
    risingMeans: "long",
    lookback: 3,
    minChangePct: 0.1,
    note: "每月約 7 日公布，市場最看重的央行購金指標",
  },
  {
    id: "rbi-reserves",
    label: "印度 RBI 黃金儲備",
    // RBI's own weekly bulletin isn't on DBnomics; what is there is the monthly
    // reserve template. Declared monthly so the weight ceiling matches reality.
    frequency: "monthly",
    series: [
      "IMF/IRFCL/M.IN.RAFAGOLDV_OZT",
      "IMF/IFS/M.IN.RAFAGOLDV_OZT",
      "IMF/IRFCL/M.IN.RAFAGOLD_USD",
    ],
    releaseLagDays: 14,
    risingMeans: "long",
    lookback: 3,
    minChangePct: 0.1,
    note: "印度央行儲備，近年主要買家之一",
  },
  {
    id: "tcmb-reserves",
    label: "土耳其 TCMB 黃金儲備",
    frequency: "monthly",
    series: [
      "IMF/IRFCL/M.TR.RAFAGOLDV_OZT",
      "IMF/IFS/M.TR.RAFAGOLDV_OZT",
      "IMF/IRFCL/M.TR.RAFAGOLD_USD",
    ],
    releaseLagDays: 14,
    risingMeans: "long",
    lookback: 3,
    minChangePct: 0.2,
    note: "土耳其是近年主要買家之一",
  },
  {
    id: "cbr-reserves",
    label: "俄羅斯央行 黃金儲備",
    frequency: "monthly",
    series: [
      "IMF/IRFCL/M.RU.RAFAGOLDV_OZT",
      "IMF/IFS/M.RU.RAFAGOLDV_OZT",
      "IMF/IRFCL/M.RU.RAFAGOLD_USD",
    ],
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
    series: [
      "IMF/IRFCL/M.W00.RAFAGOLDV_OZT",
      "IMF/IFS/M.W00.RAFAGOLDV_OZT",
      "IMF/IFS/M.W00.RAFAGOLD_USD",
    ],
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
 *
 * One period plus its publication lag, plus a few days of slack for holidays
 * and irregular release calendars. `observed` is the cadence the series
 * actually publishes at; when it is coarser than what the source declared, it
 * wins — otherwise a mislabelled source is permanently disabled by a clock that
 * never applied to it.
 */
export function maxAgeDays(source: GoldFlowSource, observed?: SourceFrequency): number {
  const frequency = observed ? coarser(source.frequency, observed) : source.frequency;
  return FREQUENCY_DAYS[frequency] + source.releaseLagDays + 7;
}

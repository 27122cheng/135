import {
  DBNOMICS_GOLD_SOURCES,
  FREQUENCY_WEIGHT_CAP,
  maxAgeDays,
  type GoldFlowSource,
} from "@/config/gold-fundamentals";
import type { BiasItem } from "@/types/signal";
import {
  fetchDbnomicsSeries,
  periodEndDate,
  type DbnomicsSeries,
} from "../data-sources/dbnomics";

/**
 * 央行購金與黃金流向 → 基本面 BiasItems.
 *
 * One item per source, never a blended one. The spec forbids summing different
 * frequencies into a single factor, and the clean way to guarantee that is to
 * never build a combined number in the first place: a monthly PBoC print and a
 * weekly RBI print stay separate items with separate weight ceilings, and the
 * scoring engine adds them the same way it adds any other evidence.
 *
 * Every factor is gated on freshness. A central bank series that stopped
 * updating four months ago says nothing about today, so it is dropped and
 * reported rather than scored at its last known value.
 */

export interface GoldFlowResult {
  items: BiasItem[];
  /** Sources that were fetched but not scored, and why. */
  skipped: Array<{ label: string; reason: string }>;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Turns one series into a factor, or explains why it can't be one.
 *
 * Exported for tests: the freshness gate and the weight ceiling are the two
 * rules most likely to be broken by a later edit, and both are pure arithmetic
 * over the series — no network needed to check them.
 */
export function buildGoldFlowItem(
  source: GoldFlowSource,
  series: DbnomicsSeries,
  now: Date = new Date(),
): { item: BiasItem | null; reason: string | null } {
  const points = series.points;
  if (points.length < source.lookback + 1) {
    return {
      item: null,
      reason: `只有 ${points.length} 筆觀測，不足以計算 ${source.lookback} 期變化`,
    };
  }

  const latest = points[points.length - 1];
  const periodEnd = periodEndDate(latest.period);
  if (!periodEnd) {
    return { item: null, reason: `無法解析期間格式「${latest.period}」` };
  }

  // Freshness is judged from the end of the period the observation covers,
  // not from its label — see periodEndDate.
  const ageDays = Math.floor((now.getTime() - periodEnd.getTime()) / 86_400_000);
  const limit = maxAgeDays(source);
  if (ageDays > limit) {
    return {
      item: null,
      reason: `最新期間 ${latest.period} 已過期 ${ageDays} 天（上限 ${limit} 天＝${source.frequency} 週期＋公布落後 ${source.releaseLagDays} 天），停用此因子`,
    };
  }

  const past = points[points.length - 1 - source.lookback];
  if (!(Math.abs(past.value) > 0)) {
    return { item: null, reason: `基期數值為 0，無法計算變化率` };
  }
  const changePct = ((latest.value - past.value) / Math.abs(past.value)) * 100;

  const cap = FREQUENCY_WEIGHT_CAP[source.frequency];
  // Below the noise floor, or a tier that is chart background only: report the
  // number, claim no direction. A weight-0 item still shows in the UI.
  const significant = Math.abs(changePct) >= source.minChangePct;
  const weight: 0 | 1 | 2 = significant ? cap : 0;
  const rising = changePct > 0;
  const direction =
    weight === 0
      ? "neutral"
      : rising
        ? source.risingMeans
        : source.risingMeans === "long"
          ? "short"
          : "long";

  return {
    item: {
      dimension: "基本面",
      factor: `${source.label}（${source.frequency === "monthly" ? "月頻" : source.frequency === "weekly" ? "週頻" : source.frequency === "daily" ? "日頻" : "季頻"}）`,
      direction,
      weight,
      evidence:
        `${latest.period} ${round(latest.value)}（${source.lookback} 期前 ${round(past.value)}，` +
        `變化 ${changePct >= 0 ? "+" : ""}${round(changePct)}%），as_of ${latest.period}，` +
        `資料 ${ageDays} 天前` +
        (weight === 0 && significant ? "，此頻率權重上限為 0，僅供參考" : "") +
        (!significant ? `，變化未達 ${source.minChangePct}% 門檻，不計方向` : ""),
      source: `DBnomics ${series.seriesId}（${source.note}；權重上限 ${cap}，依頻率分層）`,
    },
    reason: null,
  };
}

/** Fetches every DBnomics-backed gold source and turns each into its own factor. */
export async function analyzeGoldFlows(gaps: string[]): Promise<GoldFlowResult> {
  const skipped: Array<{ label: string; reason: string }> = [];

  const fetched = await Promise.all(
    DBNOMICS_GOLD_SOURCES.map(async (source) => {
      // Each source keeps its own gap buffer: one unavailable series should
      // not fill data_gaps on behalf of the four that worked.
      const local: string[] = [];
      const series = await fetchDbnomicsSeries(source.series, local);
      return { source, series, local };
    }),
  );

  const items: BiasItem[] = [];
  for (const { source, series } of fetched) {
    if (!series) {
      skipped.push({ label: source.label, reason: "DBnomics 查無此序列或取得失敗" });
      continue;
    }
    const { item, reason } = buildGoldFlowItem(source, series);
    if (item) items.push(item);
    else if (reason) skipped.push({ label: source.label, reason });
  }

  if (items.length === 0) {
    gaps.push(
      `央行購金／黃金流向：${DBNOMICS_GOLD_SOURCES.length} 個來源都無法計分（${skipped
        .slice(0, 2)
        .map((s) => `${s.label}：${s.reason}`)
        .join("；")}）`,
    );
  } else if (skipped.length > 0) {
    // A working majority shouldn't be drowned out, so the detail is condensed.
    gaps.push(
      `央行購金／黃金流向：${items.length} 個來源計分，${skipped.length} 個停用（${skipped
        .map((s) => s.label)
        .join("、")}）`,
    );
  }

  return { items, skipped };
}

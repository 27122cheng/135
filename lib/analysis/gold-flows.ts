import {
  DBNOMICS_GOLD_SOURCES,
  FREQUENCY_WEIGHT_CAP,
  coarser,
  maxAgeDays,
  type GoldFlowSource,
  type SourceFrequency,
} from "@/config/gold-fundamentals";
import type { BiasItem } from "@/types/signal";
import {
  fetchDbnomicsSeries,
  inferFrequency,
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

/** Why a source produced no factor. Kept structured so the gap can be summarised. */
export type SkipKind = "unresolved" | "stale" | "insufficient" | "unusable";

export interface SkippedSource {
  label: string;
  kind: SkipKind;
  reason: string;
  /** Latest period seen across the candidates, when any resolved. */
  latestPeriod: string | null;
}

export interface GoldFlowResult {
  items: BiasItem[];
  /** Sources that were fetched but not scored, and why. */
  skipped: SkippedSource[];
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

const FREQUENCY_LABEL: Record<SourceFrequency, string> = {
  daily: "日頻",
  weekly: "週頻",
  monthly: "月頻",
  quarterly: "季頻",
  yearly: "年頻",
};

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
): { item: BiasItem | null; kind: SkipKind | null; reason: string | null } {
  const points = series.points;
  if (points.length < source.lookback + 1) {
    return {
      item: null,
      kind: "insufficient",
      reason: `只有 ${points.length} 筆觀測，不足以計算 ${source.lookback} 期變化`,
    };
  }

  const latest = points[points.length - 1];
  const periodEnd = periodEndDate(latest.period);
  if (!periodEnd) {
    return { item: null, kind: "unusable", reason: `無法解析期間格式「${latest.period}」` };
  }

  // The series' own cadence, not the declared one, decides how old is too old.
  // The weight ceiling takes the coarser of the two, so a source can never be
  // scored higher than either its configuration or its actual data allows.
  const observed = inferFrequency(points);
  const effective = observed ? coarser(source.frequency, observed) : source.frequency;

  // Freshness is judged from the end of the period the observation covers,
  // not from its label — see periodEndDate.
  const ageDays = Math.floor((now.getTime() - periodEnd.getTime()) / 86_400_000);
  const limit = maxAgeDays(source, observed ?? undefined);
  if (ageDays > limit) {
    return {
      item: null,
      kind: "stale",
      reason: `最新期間 ${latest.period} 已過期 ${ageDays} 天（上限 ${limit} 天＝${effective} 週期＋公布落後 ${source.releaseLagDays} 天），停用此因子`,
    };
  }

  const past = points[points.length - 1 - source.lookback];
  if (!(Math.abs(past.value) > 0)) {
    return { item: null, kind: "unusable", reason: `基期數值為 0，無法計算變化率` };
  }
  const changePct = ((latest.value - past.value) / Math.abs(past.value)) * 100;

  const cap = FREQUENCY_WEIGHT_CAP[effective];
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
      factor: `${source.label}（${FREQUENCY_LABEL[effective]}）`,
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
    kind: null,
    reason: null,
  };
}

/**
 * Tries a source's candidate series in order and returns the first that yields
 * a factor.
 *
 * A dead dataset is indistinguishable from a correct id at fetch time — IMF/IFS
 * answered every request while sitting 400 days behind — so resolving is not
 * enough; a candidate only wins if it also passes the freshness gate.
 */
async function resolveSource(
  source: GoldFlowSource,
): Promise<{ item: BiasItem | null; skip: SkippedSource | null; notes: string[] }> {
  let best: SkippedSource | null = null;
  // Each candidate keeps its own gap buffer: a code that turns out to be wrong
  // should not fill data_gaps on behalf of the one that worked. They are still
  // kept, because if DBnomics itself is rate-limited or down, that message is
  // the only thing explaining why all five sources vanished at once.
  const notes: string[] = [];

  for (const seriesId of source.series) {
    const series = await fetchDbnomicsSeries(seriesId, notes);
    if (!series) {
      best ??= {
        label: source.label,
        kind: "unresolved",
        reason: `DBnomics 查無序列 ${seriesId}`,
        latestPeriod: null,
      };
      continue;
    }

    const { item, kind, reason } = buildGoldFlowItem(source, series);
    if (item) return { item, skip: null, notes };

    const candidate: SkippedSource = {
      label: source.label,
      kind: kind ?? "unusable",
      reason: `${reason ?? "無法計分"}（${seriesId}）`,
      latestPeriod: series.points.at(-1)?.period ?? null,
    };
    // A resolved-but-stale candidate says more than a missing one, so it
    // replaces an "unresolved" placeholder even though both failed.
    if (!best || best.kind === "unresolved") best = candidate;
  }

  return { item: null, skip: best, notes };
}

/** Summarises the skips into one line instead of five. */
function summarise(skipped: SkippedSource[], notes: string[]): string {
  // A transport-level problem outranks anything the per-series logic can say:
  // if DBnomics is rate-limited or unreachable, "序列停在 2025-06" would send
  // the reader after a config bug that isn't there.
  const transport = notes.find((n) => !n.includes("查無"));
  if (transport && skipped.every((s) => s.kind === "unresolved")) return transport;

  const stale = skipped.filter((s) => s.kind === "stale");
  if (stale.length === skipped.length && stale.length > 0) {
    const periods = stale
      .map((s) => s.latestPeriod)
      .filter((p): p is string => p !== null)
      .sort();
    const range =
      periods.length > 0
        ? `最新只到 ${periods.at(-1)}`
        : "序列已停止更新";
    // Every source stale at once is not a wrong series code and not a failed
    // fetch — it is the upstream mirror sitting a year behind, which nothing in
    // this repo can fix. Worded to land in the 先天限制 bucket (see
    // lib/data-gaps.ts) so it stops appearing under 本次取得失敗 every scan.
    return `DBnomics 的 IMF 資料集已停更，${range}，此因子暫時無可用來源`;
  }
  const shown = skipped.slice(0, 3).map((s) => `${s.label}：${s.reason}`);
  return shown.join("；") + (skipped.length > 3 ? `；…等 ${skipped.length} 個` : "");
}

/** Fetches every DBnomics-backed gold source and turns each into its own factor. */
export async function analyzeGoldFlows(gaps: string[]): Promise<GoldFlowResult> {
  const resolved = await Promise.all(DBNOMICS_GOLD_SOURCES.map((source) => resolveSource(source)));

  const items = resolved.map((r) => r.item).filter((i): i is BiasItem => i !== null);
  const skipped = resolved.map((r) => r.skip).filter((s): s is SkippedSource => s !== null);
  const notes = [...new Set(resolved.flatMap((r) => r.notes))];

  if (items.length === 0) {
    gaps.push(
      `央行購金／黃金流向：${DBNOMICS_GOLD_SOURCES.length} 個來源都無法計分（${summarise(skipped, notes)}）`,
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

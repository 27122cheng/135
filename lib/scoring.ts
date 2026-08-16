import type { BiasItem, EntryStructure, Grade } from "@/types/signal";
import { isNearEntry } from "./analysis/proximity";

/**
 * 佐證層上限 — how much the lagging dimensions may move the vote.
 *
 * The six dimensions were counted as equals, and for a 24-hour macro market
 * that is the wrong model. Two of them report the *past*: CFTC COT is
 * Tuesday's positioning published on Friday, and the fund-flow series behind
 * it is weekly. In a trend that has just turned they are reliably on the
 * losing side — that is what a three-day lag means — so counting them at the
 * same rate as this morning's price structure does not add caution, it adds
 * a systematic drag against every fresh move.
 *
 * The result was visible on the live board: 方向分 2、結構分 10 on symbol
 * after symbol. A bias score of 2 is not a market with no opinion, it is six
 * dimensions cancelling each other out, and it fails the grade table's
 * `biasScore >= 6` gate by construction no matter how clean the chart is.
 *
 * So the lagging dimensions are capped in aggregate rather than scaled per
 * item: they can still confirm, still oppose, still be listed in full — but
 * together they cannot outweigh what price is doing now. This is the
 * migration spec's own instruction («COT 只是佐證，別給它太高權重») applied
 * to the arithmetic instead of the prose.
 *
 * Capped, not deleted: an extreme COT reading still gets its own veto through
 * the S8 intervention, which is where a positioning extreme belongs — as a
 * reason to stand aside, not as a vote against the chart.
 */
const CORROBORATING_DIMENSIONS = new Set(["籌碼面", "資金流", "未平倉"]);
const CORROBORATING_CAP = 2;

/**
 * Net directional weight, with the corroborating layers capped.
 *
 * Shared by `pickDirection` and `computeBiasScore` on purpose: the direction
 * and the conviction behind it must be computed the same way, or the system
 * picks a side by one rule and then scores it by another.
 */
export function weightedNet(biasItems: BiasItem[]): number {
  let primary = 0;
  let corroborating = 0;
  for (const item of biasItems) {
    const delta =
      item.direction === "long" ? item.weight : item.direction === "short" ? -item.weight : 0;
    if (CORROBORATING_DIMENSIONS.has(item.dimension)) corroborating += delta;
    else primary += delta;
  }
  const clamped = Math.max(-CORROBORATING_CAP, Math.min(CORROBORATING_CAP, corroborating));
  return primary + clamped;
}

/**
 * bias_score = net weight behind `direction`, with the lagging dimensions
 * capped (see CORROBORATING_CAP). 'neutral' items contribute 0 either way.
 */
export function computeBiasScore(direction: "long" | "short", biasItems: BiasItem[]): number {
  const net = weightedNet(biasItems);
  return direction === "long" ? net : -net;
}

/**
 * entry_structure_score = Σ strength of structures that actually protect the entry:
 *  - long:  role='support'    AND price <= entry_zone.high AND near the entry
 *  - short: role='resistance' AND price >= entry_zone.low  AND near the entry
 * Hard rule — do not count structures on the wrong side or too far from entry.
 *
 * "Near" was a flat 1.5% of price and is now 2×ATR — see lib/analysis/proximity.ts
 * for why a percentage meant four different things across the nine instruments.
 * The percentage remains as the fallback when ATR cannot be computed.
 */
export function computeEntryStructureScore(
  direction: "long" | "short",
  entryZone: { low: number; high: number },
  structures: EntryStructure[],
  atr: number | null = null,
): number {
  const mid = (entryZone.low + entryZone.high) / 2;
  return structures
    .filter((s) => {
      if (!isNearEntry(s, mid, atr)) return false;
      if (direction === "long") return s.role === "support" && s.price <= entryZone.high;
      return s.role === "resistance" && s.price >= entryZone.low;
    })
    .reduce((sum, s) => sum + s.strength, 0);
}

/**
 * Grade lookup table, evaluated exactly as specified. Disqualifiers
 * (total<3, bias_score<=0, entry_structure_score=0) are checked first since
 * they are explicit overrides.
 *
 * Two departures from the literal table, both to remove score inversions where
 * a *better* signal graded worse:
 *
 *  - The A band no longer caps at total 13. With the cap, bias 6 / structure 7
 *    (total 13) graded A while bias 6 / structure 8 (total 14) dropped to B —
 *    more structure, lower grade. A now reads "total >= 10 且 bias >= 6".
 *  - A catch-all sends any remaining total >= 14 to B. Without it those fell
 *    through every rule to no-trade, so bias 7 / structure 8 was untradeable
 *    while a weaker bias 5 / structure 4 graded B.
 *
 * One inversion is left, deliberately: with bias_score < 6, total 6-9 grades B,
 * total 10-13 is no-trade, and total 14+ is B again via the catch-all. The
 * middle band is the spec working as intended (weak directional conviction
 * shouldn't trade), and the outer two are the B band and the catch-all. Making
 * it uniform means either dropping the catch-all or giving the B band a bias
 * floor — both are scoring-policy calls, not bug fixes. Pinned by tests.
 */
export function gradeSignal(
  biasScore: number,
  entryStructureScore: number,
  totalScore: number,
  /**
   * S1 intervention — 「bias_score 門檻整體 +2 才給同等級」. Read as "整體":
   * every bias threshold rises, including the disqualifier, so a run of
   * 結構誤判 reviews makes weak-conviction signals harder to grade at all.
   * Only ever ≥ 0, so this can only make grading stricter.
   */
  biasThresholdBump = 0,
): Grade {
  const bump = Math.max(0, biasThresholdBump);
  if (totalScore < 3 || biasScore <= bump || entryStructureScore === 0) return "no-trade";
  if (totalScore >= 14 && biasScore >= 8 + bump && entryStructureScore >= 4) return "A+";
  if (totalScore >= 10 && biasScore >= 6 + bump) return "A";
  if (totalScore >= 6 && totalScore <= 9) return "B";
  if (totalScore >= 14) return "B";
  if (totalScore >= 3 && totalScore <= 5) return "C";
  return "no-trade";
}

/**
 * 逆勢不對稱 — a counter-trend signal must pay a higher evidence bar.
 *
 * `pickDirection` is a flat weighted vote, so a direction fighting the D1/W1
 * trend costs exactly as much as one riding it: five weight-1 macro items can
 * outvote the weight-2 trend evidence and grade an A against the tide. Every
 * part of trading logic this system encodes says those are not the same trade
 * — the swing variant already refuses to exist without the D1 trend on side,
 * and the conditioned backtest's strongest tier *is* trend agreement.
 *
 * The rule: the higher-timeframe trend is the net of the weight-2 技術面
 * items (the D1/W1 trend factors — weight-1 technical items are triggers and
 * patterns, not trend). When the chosen direction opposes that net, the bias
 * score must reach the A+ bar (8) for the grade to stand; otherwise the grade
 * steps down one notch. Not to no-trade outright — counter-trend setups with
 * overwhelming evidence are real — but a B-grade counter-trend trade drops to
 * C, below MIN_ENTRY_GRADE, which is the point.
 */
export function applyTrendAlignmentGate(
  grade: Grade,
  direction: "long" | "short",
  biasItems: BiasItem[],
  biasScore: number,
): { grade: Grade; note: string | null } {
  const trendNet = biasItems.reduce((sum, i) => {
    if (i.dimension !== "技術面" || i.weight < 2) return sum;
    if (i.direction === "long") return sum + i.weight;
    if (i.direction === "short") return sum - i.weight;
    return sum;
  }, 0);
  if (trendNet === 0) return { grade, note: null };
  const trend: "long" | "short" = trendNet > 0 ? "long" : "short";
  if (trend === direction) return { grade, note: null };
  if (biasScore >= 8) {
    return {
      grade,
      note: `逆勢訊號：D1/W1 技術面淨趨勢偏${trend === "long" ? "多" : "空"}而訊號做${direction === "long" ? "多" : "空"}，但偏向分 ${biasScore} 已達 A+ 門檻（8），評等維持`,
    };
  }
  const order: Grade[] = ["no-trade", "C", "B", "A", "A+"];
  const stepped = order[Math.max(0, order.indexOf(grade) - 1)];
  if (stepped === grade) return { grade, note: null };
  return {
    grade: stepped,
    note:
      `逆勢降級：D1/W1 技術面淨趨勢偏${trend === "long" ? "多" : "空"}而訊號做${direction === "long" ? "多" : "空"}` +
      `，逆勢單的偏向分需 ≥8（A+ 門檻）才維持原評等，目前僅 ${biasScore}，評等由 ${grade} 降為 ${stepped}`,
  };
}

export interface ScoreResult {
  biasScore: number;
  entryStructureScore: number;
  totalScore: number;
  grade: Grade;
}

export function scoreSignal(
  direction: "long" | "short",
  entryZone: { low: number; high: number },
  biasItems: BiasItem[],
  structures: EntryStructure[],
  biasThresholdBump = 0,
  atr: number | null = null,
): ScoreResult {
  const biasScore = computeBiasScore(direction, biasItems);
  const entryStructureScore = computeEntryStructureScore(direction, entryZone, structures, atr);
  const totalScore = biasScore + entryStructureScore;
  return {
    biasScore,
    entryStructureScore,
    totalScore,
    grade: gradeSignal(biasScore, entryStructureScore, totalScore, biasThresholdBump),
  };
}

/**
 * The weakest grade allowed to produce an actual entry.
 *
 * Until now nothing enforced this: the AI chose `stance`, so a C could come
 * back with a full set of levels — which it did, on SPX500 at total score 4.
 * That is inconsistent with two rules the system already applies:
 *
 *  - alerts default to A and above, so a C "trade" is one the system will not
 *    even tell you about
 *  - add-ons require A/A+, so a C trade can never be scaled into
 *
 * Presenting a recommendation the rest of the system declines to act on is
 * worse than presenting nothing. B is the floor: the band where總分 reaches 6,
 * which is where the spec starts treating a setup as a setup.
 *
 * A single named constant rather than a scattered comparison, so changing the
 * policy is one edit and the test that pins it fails loudly.
 */
export const MIN_ENTRY_GRADE: Grade = "B";

const ENTRY_ORDER: Grade[] = ["no-trade", "C", "B", "A", "A+"];

/** Whether this grade may enter at all. Nothing above this line consults the AI. */
export function gradeAllowsEntry(grade: Grade): boolean {
  return ENTRY_ORDER.indexOf(grade) >= ENTRY_ORDER.indexOf(MIN_ENTRY_GRADE);
}

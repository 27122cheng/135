import type { BiasItem, EntryStructure, Grade } from "@/types/signal";

/**
 * bias_score = Σ(weight of items agreeing with `direction`) - Σ(weight of items opposing it).
 * 'neutral' items contribute 0 either way. Hard rule — do not modify weighting.
 */
export function computeBiasScore(direction: "long" | "short", biasItems: BiasItem[]): number {
  const opposite = direction === "long" ? "short" : "long";
  return biasItems.reduce((sum, item) => {
    if (item.direction === direction) return sum + item.weight;
    if (item.direction === opposite) return sum - item.weight;
    return sum;
  }, 0);
}

/**
 * entry_structure_score = Σ strength of structures that actually protect the entry:
 *  - long:  role='support'    AND price <= entry_zone.high AND distance_pct <= 1.5%
 *  - short: role='resistance' AND price >= entry_zone.low  AND distance_pct <= 1.5%
 * Hard rule — do not count structures on the wrong side or too far from entry.
 */
export function computeEntryStructureScore(
  direction: "long" | "short",
  entryZone: { low: number; high: number },
  structures: EntryStructure[],
): number {
  return structures
    .filter((s) => {
      if (Math.abs(s.distance_pct) > 1.5) return false;
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
): ScoreResult {
  const biasScore = computeBiasScore(direction, biasItems);
  const entryStructureScore = computeEntryStructureScore(direction, entryZone, structures);
  const totalScore = biasScore + entryStructureScore;
  return {
    biasScore,
    entryStructureScore,
    totalScore,
    grade: gradeSignal(biasScore, entryStructureScore, totalScore, biasThresholdBump),
  };
}

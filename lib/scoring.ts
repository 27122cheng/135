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
 * The A band is capped at 13, so a signal scoring 14+ that misses A+ on one
 * component matched no rule at all and fell through to no-trade — meaning
 * bias 7 / structure 8 (total 15) was untradeable while a weaker bias 5 /
 * structure 4 (total 9) graded B. The catch-all below fixes that: 14+ without
 * A+ lands on B rather than being thrown away.
 *
 * Two behaviours this deliberately leaves alone:
 *  - total 10-13 with bias_score < 6 stays no-trade. That is the spec working
 *    as intended — weak directional conviction shouldn't trade regardless of
 *    how much structure sits nearby.
 *  - The A band still caps at 13, so with bias 6-7 a total of 13 grades A while
 *    14 grades B. The catch-all stops the fall to no-trade but not that step
 *    down. Dropping `totalScore <= 13` from the A rule would close it; that is
 *    a scoring-policy change, not a bug fix, so it is left to the operator.
 *    Pinned by tests so it can't shift unnoticed.
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
  if (totalScore >= 10 && totalScore <= 13 && biasScore >= 6 + bump) return "A";
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

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
 * they are explicit overrides. Any combination the table doesn't cover
 * (e.g. total 10-13 with bias_score<6) falls through to 'no-trade' —
 * consistent with the spec's rule to never force a grade without support.
 */
export function gradeSignal(
  biasScore: number,
  entryStructureScore: number,
  totalScore: number,
): Grade {
  if (totalScore < 3 || biasScore <= 0 || entryStructureScore === 0) return "no-trade";
  if (totalScore >= 14 && biasScore >= 8 && entryStructureScore >= 4) return "A+";
  if (totalScore >= 10 && totalScore <= 13 && biasScore >= 6) return "A";
  if (totalScore >= 6 && totalScore <= 9) return "B";
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
): ScoreResult {
  const biasScore = computeBiasScore(direction, biasItems);
  const entryStructureScore = computeEntryStructureScore(direction, entryZone, structures);
  const totalScore = biasScore + entryStructureScore;
  return { biasScore, entryStructureScore, totalScore, grade: gradeSignal(biasScore, entryStructureScore, totalScore) };
}

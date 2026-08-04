import {
  PREVENTABLE_TAGS,
  type JournalEntry,
  type StopReasonTag,
} from "@/types/journal";

/**
 * severity — 不准讓 AI 自由評分.
 *
 * The spec's formula, implemented literally:
 *
 *   severity = clamp(1, 5, round(
 *       (可事前預防 ? 2 : 0)
 *     + (本次虧損 > 平均虧損 * 1.5 ? 1 : 0)
 *     + (近 20 筆中同 tag 出現次數 >= 3 ? 2 : 0)
 *   ))
 *
 * Every input is a fact already on record: the tag the reviewer picked, this
 * trade's loss, the average loss, and a count over the last 20 entries. No
 * model is consulted, and the same inputs always produce the same number —
 * which is what makes the per-tag averages in the intervention rules mean
 * anything at all.
 *
 * Note the clamp floor of 1: a loss with none of the three conditions still
 * scores 1, not 0. There is no such thing as a zero-severity loss.
 */

function clamp(min: number, max: number, value: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface SeverityInput {
  tag: StopReasonTag;
  /** This trade's pnl_pct (negative for a loss). */
  pnlPct: number;
  /** Prior entries, newest first — the caller decides how many to pass. */
  history: JournalEntry[];
}

export interface SeverityBreakdown {
  severity: number;
  preventable: boolean;
  /** Mean of |pnl_pct| over prior losses; null when there is no history yet. */
  averageLossPct: number | null;
  isOutsizedLoss: boolean;
  sameTagInLast20: number;
  isRepeatOffender: boolean;
}

/** Returns the score plus every term that produced it, so the UI can show its work. */
export function computeSeverity(input: SeverityInput): SeverityBreakdown {
  const preventable = PREVENTABLE_TAGS[input.tag];

  // "平均虧損" is the mean loss over prior losing trades. Wins would drag the
  // mean toward zero and make almost every loss look outsized, so they are excluded.
  const priorLosses = input.history.filter((e) => e.result === "loss" && e.pnl_pct < 0);
  const averageLossPct =
    priorLosses.length > 0
      ? priorLosses.reduce((sum, e) => sum + Math.abs(e.pnl_pct), 0) / priorLosses.length
      : null;

  const thisLoss = Math.abs(input.pnlPct);
  // With no prior losses there is no average to beat, so this term stays 0
  // rather than defaulting to "outsized" on the very first entry.
  const isOutsizedLoss = averageLossPct !== null && thisLoss > averageLossPct * 1.5;

  const sameTagInLast20 = input.history
    .slice(0, 20)
    .filter((e) => e.stop_reason_tag === input.tag).length;
  const isRepeatOffender = sameTagInLast20 >= 3;

  const raw =
    (preventable ? 2 : 0) + (isOutsizedLoss ? 1 : 0) + (isRepeatOffender ? 2 : 0);

  return {
    severity: clamp(1, 5, Math.round(raw)),
    preventable,
    averageLossPct,
    isOutsizedLoss,
    sameTagInLast20,
    isRepeatOffender,
  };
}

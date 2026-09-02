import type { ForwardEvidence, ForwardEvidenceItem } from "@/types/signal";
import { CONDITIONS, type LabContext } from "./lab-conditions";
import type { ForwardStat } from "./lab-forward";

/**
 * 前進驗證證據 —— the lab's own scoreboard, read at signal time.
 *
 * The forward test opens a paper trade for every condition on every bar it
 * fires, resolves it under the shared exit engine, and keeps the record per
 * condition and direction. Production has 23–39 such trades open per symbol
 * and settles up to a dozen a sweep: continuously accumulating evidence about
 * which setups have actually paid on this instrument, measured on real
 * candles under the real management rules. Until now it reached the signal
 * only if a person pressed 採用 on a combination — everything short of that
 * was measured and then ignored.
 *
 * This reads it at signal time: which conditions with a verified record are
 * firing on the newest bar, for this direction and against it. It feeds the
 * **confidence score**, bounded, and nothing else — not the grade, not the
 * veto, not a gate — because a condition's forward record is measured under
 * the lab's fixed protocol, not this plan's geometry. It is evidence about
 * direction and timing, and confidence is where that kind of evidence is
 * priced.
 *
 * Verified means resolved ≥ {@link FORWARD_MIN_RESOLVED} with positive net
 * expectancy. Below the sample floor a record is noise, and a noisy record
 * moving a headline number is how a made-up figure gets laundered.
 */
export const FORWARD_MIN_RESOLVED = 20;

export function forwardEvidence(input: {
  direction: "long" | "short";
  stats: ForwardStat[];
  ctx: LabContext;
  bar: number;
  barTime: string;
}): ForwardEvidence {
  const { direction, stats, ctx, bar, barTime } = input;
  const opposite: "long" | "short" = direction === "long" ? "short" : "long";
  const verified = stats.filter(
    (s) => s.resolved >= FORWARD_MIN_RESOLVED && s.expectancyR !== null && s.expectancyR > 0,
  );

  const firing = (s: ForwardStat): boolean => {
    const condition = CONDITIONS.find((c) => c.id === s.conditionId);
    if (!condition) return false;
    try {
      return condition.test(ctx, bar, s.direction);
    } catch {
      return false;
    }
  };
  const item = (s: ForwardStat): ForwardEvidenceItem => ({
    id: s.conditionId,
    label: s.label,
    direction: s.direction,
    resolved: s.resolved,
    hitRate: s.hitRate,
    expectancyR: s.expectancyR,
  });

  return {
    supporting: verified.filter((s) => s.direction === direction && firing(s)).map(item),
    opposing: verified.filter((s) => s.direction === opposite && firing(s)).map(item),
    verifiedCount: verified.length,
    barTime,
  };
}

/** Bounds on what the evidence may do to the score. */
export const FORWARD_SUPPORT_POINTS = 2;
export const FORWARD_SUPPORT_CAP = 8;
export const FORWARD_OPPOSE_POINTS = 2;
export const FORWARD_OPPOSE_CAP = 6;

/**
 * The confidence adjustment, and the line that explains it.
 *
 * Asymmetric caps on purpose. A B-grade signal starts 15 points above the
 * entry bar; −6 cannot cross it alone, so opposing evidence tips only a
 * signal that other degradations have already brought to the edge — which
 * is what a veto for degraded conditions should do, and no more. Support is
 * worth a little more than opposition because it is corroboration of a
 * direction the six dimensions already chose, not a second opinion.
 */
export function forwardEvidenceDelta(ev: ForwardEvidence | null | undefined): {
  delta: number;
  factor: string | null;
} {
  if (!ev || (ev.supporting.length === 0 && ev.opposing.length === 0)) {
    return { delta: 0, factor: null };
  }
  const plus = Math.min(FORWARD_SUPPORT_CAP, ev.supporting.length * FORWARD_SUPPORT_POINTS);
  const minus = Math.min(FORWARD_OPPOSE_CAP, ev.opposing.length * FORWARD_OPPOSE_POINTS);
  const delta = plus - minus;
  const name = (i: ForwardEvidenceItem) =>
    `${i.label}（${i.resolved} 筆 ${i.expectancyR !== null && i.expectancyR >= 0 ? "+" : ""}${i.expectancyR}R）`;
  const factor =
    `實驗室前進驗證（${delta > 0 ? "+" : delta === 0 ? "±" : ""}${delta}）：` +
    (ev.supporting.length > 0 ? `同向成立 ${ev.supporting.map(name).join("、")}` : "同向無") +
    (ev.opposing.length > 0 ? `；反向成立 ${ev.opposing.map(name).join("、")}` : "");
  return { delta, factor };
}

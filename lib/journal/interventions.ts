import type { Grade } from "@/types/signal";
import {
  STOP_REASON_LABELS,
  type AppliedIntervention,
  type JournalEntry,
  type StopReasonTag,
  type TagStat,
} from "@/types/journal";

/**
 * 干涉機制 — the loop that closes: past stop-losses tighten future signals.
 *
 * Rule 3 of the spec is the one that matters: 干涉只做「降級 / 加嚴門檻」，
 * 永遠不准做升級或放寬. That is enforced structurally rather than by careful
 * coding — see `applyGradePenalties` and `assertNeverLoosened` below. Every
 * knob this module produces is a tightening, and the final guard re-checks the
 * result against the untouched baseline before it is allowed out.
 */

/** How many journal entries the intervention rules look back over. */
export const LOOKBACK = 30;
/** A tag must appear at least this often to trigger anything. */
export const MIN_COUNT = 3;
/** ...and its mean severity must be at least this. */
export const MIN_AVG_SEVERITY = 3;

const GRADE_ORDER: Grade[] = ["no-trade", "C", "B", "A", "A+"];

function gradeRank(grade: Grade): number {
  return GRADE_ORDER.indexOf(grade);
}

/** One step down the ladder. no-trade is the floor. */
export function downgrade(grade: Grade): Grade {
  const rank = gradeRank(grade);
  return rank <= 0 ? "no-trade" : GRADE_ORDER[rank - 1];
}

/** Counts and mean severity per tag over the most recent `LOOKBACK` entries. */
export function summariseTags(history: JournalEntry[]): TagStat[] {
  const window = history.slice(0, LOOKBACK);
  const byTag = new Map<StopReasonTag, JournalEntry[]>();
  for (const entry of window) {
    if (!entry.stop_reason_tag) continue;
    const list = byTag.get(entry.stop_reason_tag) ?? [];
    list.push(entry);
    byTag.set(entry.stop_reason_tag, list);
  }

  return Array.from(byTag.entries())
    .map(([tag, entries]) => {
      // A null severity means the entry predates the formula; excluded from the
      // mean rather than counted as zero, which would suppress real triggers.
      const scored = entries.filter((e) => e.severity !== null);
      const avgSeverity =
        scored.length > 0
          ? scored.reduce((sum, e) => sum + (e.severity ?? 0), 0) / scored.length
          : 0;
      return {
        tag,
        count: entries.length,
        avgSeverity: Math.round(avgSeverity * 100) / 100,
        cumulativeLossPct:
          Math.round(entries.reduce((sum, e) => sum + e.pnl_pct, 0) * 100) / 100,
      };
    })
    .sort((a, b) => b.count - a.count);
}

/** Tags that meet both thresholds, i.e. the ones whose penalty is now active. */
export function triggeredTags(stats: TagStat[]): TagStat[] {
  return stats.filter((s) => s.count >= MIN_COUNT && s.avgSeverity >= MIN_AVG_SEVERITY);
}

/**
 * The knobs the pipeline reads. Every field is a *tightening* — there is no
 * representable value that loosens anything, which is what makes rule 3 hold
 * by construction rather than by review.
 */
export interface InterventionEffects {
  /** S1: bias_score must clear its band by this much extra. Only ever ≥ 0. */
  biasScoreThresholdBump: number;
  /** S2: entry zone width multiplier. Only ever ≤ 1. */
  entryZoneWidthFactor: number;
  /** S2: pullback confirmation becomes mandatory. */
  requirePullbackConfirmation: boolean;
  /** S3: ATR multiple for the stop's buffer beyond structure. Only ever ≥ default. */
  stopBufferAtrMultiple: number;
  /** S4: downgrade one step when a high-impact release lands within 24h. */
  downgradeOnHighImpactEvent: boolean;
  /** S5: downgrade one step when generated outside the main sessions. */
  downgradeOutsideMainSession: boolean;
  /** S7: force no-trade when the macro read opposes the signal. */
  noTradeOnFundamentalConflict: boolean;
  /** S8: force no-trade when COT is at an extreme opposing the signal. */
  noTradeOnPositioningConflict: boolean;
  /**
   * 實績校準 — extra hit rate demanded on top of the day floor when the
   * realized win rate of auto-tracked real entries falls well short of what
   * the backtest floor promised. Not tied to any S-tag: the trigger is the
   * scoreboard itself. Only ever ≥ 0, and it releases on its own — a window
   * whose realized rate recovers computes back to zero next scan.
   */
  dayHitRateFloorBump: number;
  /** For display: what was applied and why. */
  applied: AppliedIntervention[];
}

/** The un-intervened baseline. `0.5` matches lib/entry-exit.ts's default buffer. */
export const DEFAULT_EFFECTS: InterventionEffects = {
  biasScoreThresholdBump: 0,
  entryZoneWidthFactor: 1,
  requirePullbackConfirmation: false,
  stopBufferAtrMultiple: 0.5,
  downgradeOnHighImpactEvent: false,
  downgradeOutsideMainSession: false,
  noTradeOnFundamentalConflict: false,
  noTradeOnPositioningConflict: false,
  dayHitRateFloorBump: 0,
  applied: [],
};

function evidenceFor(stat: TagStat): string {
  return `近 ${LOOKBACK} 筆中 ${stat.tag} 出現 ${stat.count} 次，平均 severity ${stat.avgSeverity}`;
}

/**
 * Builds the effects for one symbol from its own journal history.
 *
 * S6 (紀律問題) deliberately has no penalty: the system cannot stop a person
 * from ignoring its own rules, and pretending otherwise by tightening some
 * unrelated knob would be theatre. It still shows up in /review.
 */
export function computeInterventions(history: JournalEntry[]): InterventionEffects {
  const stats = summariseTags(history);
  const triggered = triggeredTags(stats);
  const effects: InterventionEffects = { ...DEFAULT_EFFECTS, applied: [] };

  const window = history.slice(0, LOOKBACK);
  const triggeringDates = (tag: StopReasonTag) =>
    window
      .filter((e) => e.stop_reason_tag === tag)
      .map((e) => e.closed_at.slice(0, 10));

  for (const stat of triggered) {
    const record = (effect: string) =>
      effects.applied.push({
        tag: stat.tag,
        effect,
        evidence: evidenceFor(stat),
        triggered_by: triggeringDates(stat.tag),
      });

    switch (stat.tag) {
      case "S1":
        effects.biasScoreThresholdBump = Math.max(effects.biasScoreThresholdBump, 2);
        record("bias_score 門檻整體 +2，方向分不夠強就降等");
        break;
      case "S2":
        effects.entryZoneWidthFactor = Math.min(effects.entryZoneWidthFactor, 0.7);
        effects.requirePullbackConfirmation = true;
        record("進場區間收窄 30%，且強制要求回測確認因子");
        break;
      case "S3":
        effects.stopBufferAtrMultiple = Math.max(effects.stopBufferAtrMultiple, 1.0);
        record("停損的結構外 buffer 由 0.5×ATR 提高到 1.0×ATR");
        break;
      case "S4":
        effects.downgradeOnHighImpactEvent = true;
        record("24h 內有高影響力數據時，評等自動降一級");
        break;
      case "S5":
        effects.downgradeOutsideMainSession = true;
        record("非主要交易時段產生的訊號自動降一級");
        break;
      case "S6":
        // No mechanical penalty — see the note above.
        break;
      case "S7":
        effects.noTradeOnFundamentalConflict = true;
        record("基本面方向與訊號相反時，直接 no-trade");
        break;
      case "S8":
        effects.noTradeOnPositioningConflict = true;
        record("COT 處於極端且方向相反時，直接 no-trade");
        break;
    }
  }

  // ── 實績校準 ─────────────────────────────────────────────────────
  // Every real entry passed a backtest floor tied to its payoff (70% at the
  // 1:1.5 minimum, easing toward 55% as the payoff improves) — so the
  // realized win rate of those same entries is a direct audit of the
  // backtest's honesty. When enough have resolved and the audit fails, new
  // entries must clear a higher bar until the scoreboard recovers. Real
  // auto-tracked entries only: paper fills are assumed perfect and manual
  // entries never claimed the floor.
  const real = window.filter(
    (e) =>
      e.review_note?.includes("[自動追蹤]") &&
      !e.review_note.includes("[參考價位紙上追蹤]") &&
      (e.result === "win" || e.result === "loss"),
  );
  if (real.length >= 10) {
    const wins = real.filter((e) => e.result === "win").length;
    const realized = wins / real.length;
    const bump = realized < 0.45 ? 0.1 : realized < 0.55 ? 0.05 : 0;
    if (bump > 0) {
      effects.dayHitRateFloorBump = bump;
      effects.applied.push({
        tag: null,
        effect: `當沖回測勝率門檻整體 +${Math.round(bump * 100)} 個百分點（各風報比對應的門檻一併提高）`,
        evidence:
          `實績校準：最近 ${real.length} 筆正式進場實際勝率僅 ${Math.round(realized * 100)}%，` +
          `遠低於回測門檻承諾的水準（依風報比 55–70%）—— 回測偏樂觀時，新進場需要更高的安全邊際`,
        triggered_by: real.slice(0, 5).map((e) => e.closed_at.slice(0, 10)),
      });
    }
  }

  return effects;
}

/** 07:00–21:00 UTC covers the London and New York sessions and their overlap. */
export function isMainSession(at: Date): boolean {
  const hour = at.getUTCHours();
  return hour >= 7 && hour < 21;
}

export interface GradePenaltyContext {
  /** True when a high-impact release falls inside the next 24h. */
  highImpactEventWithin24h: boolean;
  /** null when unknown — e.g. no economic calendar source is configured. */
  eventDataAvailable: boolean;
  generatedAt: Date;
  fundamentalOpposesSignal: boolean;
  positioningExtremeOpposesSignal: boolean;
}

export interface GradePenaltyResult {
  grade: Grade;
  /** Human-readable lines describing each penalty that fired. */
  notes: string[];
}

/**
 * Applies the grade-affecting penalties (S4/S5/S7/S8) to an already-computed
 * grade. Takes the baseline grade and can only return the same or worse — the
 * final clamp against `baseline` is what enforces that even if a future edit
 * gets a branch wrong.
 */
export function applyGradePenalties(
  baseline: Grade,
  effects: InterventionEffects,
  ctx: GradePenaltyContext,
): GradePenaltyResult {
  let grade = baseline;
  const notes: string[] = [];

  if (effects.downgradeOnHighImpactEvent) {
    if (!ctx.eventDataAvailable) {
      // Can't confirm, so can't act. Saying so is the honest move; silently
      // downgrading on an unknown would be inventing a reason.
      notes.push(
        "S4 干涉已啟用，但無經濟數據日曆來源可確認 24h 內是否有高影響力數據，本次未套用降級",
      );
    } else if (ctx.highImpactEventWithin24h) {
      grade = downgrade(grade);
      notes.push("S4 干涉：24h 內有高影響力數據，評等降一級");
    }
  }

  if (effects.downgradeOutsideMainSession && !isMainSession(ctx.generatedAt)) {
    grade = downgrade(grade);
    notes.push("S5 干涉：訊號產生於非主要交易時段（UTC 07:00–21:00 之外），評等降一級");
  }

  if (effects.noTradeOnFundamentalConflict && ctx.fundamentalOpposesSignal) {
    grade = "no-trade";
    notes.push("S7 干涉：基本面方向與訊號相反，直接 no-trade");
  }

  if (effects.noTradeOnPositioningConflict && ctx.positioningExtremeOpposesSignal) {
    grade = "no-trade";
    notes.push("S8 干涉：COT 處於極端且方向與訊號相反，直接 no-trade");
  }

  // Rule 3, enforced rather than trusted: whatever the branches above did, the
  // result may never outrank the baseline.
  const finalGrade = gradeRank(grade) > gradeRank(baseline) ? baseline : grade;
  return { grade: finalGrade, notes };
}

/**
 * Development guard: proves the effects object only ever tightens. Called from
 * the pipeline so a future edit that loosens a knob fails loudly instead of
 * quietly making signals more permissive than the baseline.
 */
export function assertNeverLoosened(effects: InterventionEffects): void {
  const violations: string[] = [];
  if (effects.biasScoreThresholdBump < 0) violations.push("biasScoreThresholdBump < 0");
  if (effects.entryZoneWidthFactor > 1) violations.push("entryZoneWidthFactor > 1");
  if (effects.stopBufferAtrMultiple < DEFAULT_EFFECTS.stopBufferAtrMultiple) {
    violations.push("stopBufferAtrMultiple below default");
  }
  if (violations.length > 0) {
    throw new Error(`干涉規則只准加嚴，偵測到放寬：${violations.join("；")}`);
  }
}

export function describeTag(tag: StopReasonTag): string {
  return `${tag} ${STOP_REASON_LABELS[tag]}`;
}

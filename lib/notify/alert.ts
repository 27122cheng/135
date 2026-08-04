import type { Grade, SignalRow, TradeSignal } from "@/types/signal";

/**
 * Decides whether a freshly built signal is worth interrupting someone for.
 *
 * The refresh runs every 4 hours. A gold setup that stays valid all day would
 * fire six identical alerts, and the seventh would be ignored along with every
 * real one after it. So the rule is *change*, not *state*: alert when the
 * recommendation is new or has materially moved, and stay quiet when it is the
 * same call restated.
 *
 * Pure function over the current signal and the last stored one — no fetching,
 * no side effects, so the thresholds are testable without a database.
 */

const GRADE_ORDER: Grade[] = ["no-trade", "C", "B", "A", "A+"];

function rank(grade: string): number {
  const i = GRADE_ORDER.indexOf(grade as Grade);
  return i < 0 ? 0 : i;
}

/** Default floor. Below A the signal isn't worth a push notification. */
export const DEFAULT_MIN_GRADE: Grade = "A";

export function configuredMinGrade(): Grade {
  const raw = process.env.ALERT_MIN_GRADE?.trim();
  return raw && (GRADE_ORDER as string[]).includes(raw) ? (raw as Grade) : DEFAULT_MIN_GRADE;
}

/**
 * Prices count as "the same" within this fraction of the entry. Markets move
 * a little between runs; re-alerting because the entry shifted 0.05% would be
 * noise, not information.
 */
const PRICE_TOLERANCE = 0.002;

function samePrice(a: number | null, b: number | null, reference: number): boolean {
  if (a === null || b === null) return a === b;
  if (!(reference > 0)) return a === b;
  return Math.abs(a - b) / reference <= PRICE_TOLERANCE;
}

export interface AlertDecision {
  alert: boolean;
  /** Why — surfaced in the refresh response so a silent run is explainable. */
  reason: string;
}

export function shouldAlert(
  current: TradeSignal,
  previous: SignalRow | null,
  minGrade: Grade = DEFAULT_MIN_GRADE,
): AlertDecision {
  const plan = current.trade_plan;

  if (plan.stance !== "enter") {
    return { alert: false, reason: "觀望，不發送" };
  }
  if (rank(current.grade) < rank(minGrade)) {
    return { alert: false, reason: `評等 ${current.grade} 低於門檻 ${minGrade}` };
  }
  if (plan.entry === null || plan.stop_loss === null || plan.take_profit === null) {
    // A grade that says "enter" without a full set of levels is a bug
    // elsewhere; alerting on it would push an unusable recommendation.
    return { alert: false, reason: "進場計畫缺少價位，不發送" };
  }

  if (!previous) {
    return { alert: true, reason: "首次出現可執行訊號" };
  }

  const prevPlan = previous.trade_plan;
  if (prevPlan?.stance !== "enter") {
    return { alert: true, reason: "由觀望轉為進場" };
  }
  if (previous.direction !== current.direction) {
    return { alert: true, reason: `方向由 ${previous.direction} 轉為 ${current.direction}` };
  }
  if (rank(current.grade) > rank(previous.grade)) {
    return { alert: true, reason: `評等由 ${previous.grade} 提升為 ${current.grade}` };
  }

  const ref = plan.entry;
  const unchanged =
    samePrice(plan.entry, prevPlan.entry ?? null, ref) &&
    samePrice(plan.stop_loss, prevPlan.stop_loss ?? null, ref) &&
    samePrice(plan.take_profit, prevPlan.take_profit ?? null, ref);

  if (unchanged) {
    return { alert: false, reason: "與上次相同的建議，不重複發送" };
  }
  return { alert: true, reason: "進場／停損／停利價位已更新" };
}

function fmt(n: number | null): string {
  if (n === null) return "—";
  // Enough precision for FX without turning index levels into noise.
  return Math.abs(n) < 10 ? n.toFixed(5) : n.toFixed(2);
}

/**
 * The message body. Telegram-flavoured HTML; the Discord channel strips tags.
 * Deliberately compact — an alert is read on a lock screen.
 */
export function formatAlert(signal: TradeSignal, reason: string, appUrl?: string): string {
  const plan = signal.trade_plan;
  const dir = signal.direction === "long" ? "做多 ▲" : "做空 ▼";
  const lines = [
    `<b>${signal.symbol} ${dir} ${signal.grade}</b>`,
    `進場 <b>${fmt(plan.entry)}</b>`,
    `停損 ${fmt(plan.stop_loss)}　停利 ${fmt(plan.take_profit)}`,
    plan.risk_reward !== null ? `風報比 1:${plan.risk_reward}` : null,
    "",
    plan.summary,
  ];

  const strongPoints = (signal.news_digest?.key_points ?? []).filter(
    (k) => k.impact === signal.direction,
  );
  if (strongPoints.length > 0) {
    lines.push("", `新聞：${strongPoints[0].point}`);
  }

  if (signal.interventions.length > 0) {
    lines.push(`已套用 ${signal.interventions.length} 項干涉（見網站）`);
  }
  if (signal.data_gaps.length > 0) {
    lines.push(`資料缺口 ${signal.data_gaps.length} 項`);
  }

  lines.push("", `<i>觸發：${reason}</i>`);
  if (appUrl) lines.push(appUrl);

  return lines.filter((l) => l !== null).join("\n");
}

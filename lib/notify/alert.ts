import type { Grade, SignalRow, TradeSignal } from "@/types/signal";
import { getSetting } from "@/lib/settings";

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

/**
 * Async because the value can come from `app_settings` as well as the
 * environment — see lib/settings.ts. An unrecognised value falls back to the
 * default rather than throwing: a typo in a web form must not stop every alert.
 */
export async function configuredMinGrade(): Promise<Grade> {
  const raw = (await getSetting("ALERT_MIN_GRADE"))?.trim();
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
/**
 * 即時數據公布 alert — sent by the 5-minute monitor the moment a tracked print
 * appears, hours before the next scheduled scan would have noticed it.
 *
 * Deliberately states the number and the direction of the surprise but **not**
 * a trade. Re-grading nine symbols is a separate, slower job, and a message
 * that said "CPI hot → 黃金做空" would be a recommendation the scoring engine
 * hasn't actually made yet.
 */
export function formatReleaseAlert(
  fresh: Array<{
    release: { label: string; usdImpact: "stronger" | "weaker"; impactHours: number };
    value: number;
    previous: number | null;
    period: string;
  }>,
  appUrl?: string,
): string {
  const lines: Array<string | null> = [
    `<b>數據公布</b>（${fresh.length} 項）`,
  ];

  for (const f of fresh) {
    const hotter = f.previous !== null ? f.value > f.previous : null;
    const move =
      hotter === null
        ? "無前值可比"
        : `前值 ${fmt(f.previous)} → ${hotter ? "上升" : "下降"}`;
    // The dollar read only follows from the *direction* of the move, so it is
    // omitted entirely when there is nothing to compare against.
    const usd =
      hotter === null
        ? ""
        : `，美元偏${(hotter ? f.release.usdImpact : f.release.usdImpact === "stronger" ? "weaker" : "stronger") === "stronger" ? "強" : "弱"}`;
    lines.push(`${f.release.label} ${fmt(f.value)}（${f.period}，${move}${usd}）`);
  }

  lines.push("", `<i>下次掃描會把這些納入計分，影響窗 ${Math.max(...fresh.map((f) => f.release.impactHours))} 小時內有效。</i>`);
  if (appUrl) lines.push(appUrl);
  return lines.filter((l) => l !== null).join("\n");
}

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

import { breadthOf } from "@/lib/analysis/evidence";
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

/**
 * How many dimensions must point the signal's way before it interrupts a phone.
 *
 * Three of six. One dimension alone is an indicator, not a case; two can be a
 * single macro story told twice. Three independent kinds of evidence agreeing
 * is where a setup stops being a reading and starts being a confluence — and
 * confluence is what a push notification should mean.
 */
export const MIN_CONSENSUS_DIMENSIONS = 3;

export function shouldAlert(
  current: TradeSignal,
  previous: SignalRow | null,
  minGrade: Grade = DEFAULT_MIN_GRADE,
  options: {
    /**
     * True while the monitor is holding an unresolved position on this symbol.
     * One trade at a time: until it hits its stop or target and lands in the
     * review, no new entry (and no "levels updated" re-announcement) goes to
     * the phone — that stream of same-symbol pushes was indistinguishable from
     * noise. Withdrawals still pass: "the thesis behind your open trade died"
     * is exactly what an interruption is for.
     */
    openTrade?: boolean;
  } = {},
): AlertDecision {
  const plan = current.trade_plan;

  // A trade nobody can place is not worth a push notification. The analysis
  // still ran and the levels are still on the site; what is suppressed is the
  // interruption, because by the time the market reopens the gap will have
  // moved the entry out from under it — spot gold opened one session 2.4% above
  // the previous close while an alert built on that close sat unread.
  if (current.market_closed) {
    return {
      alert: false,
      reason: current.market_closed_reason ?? "市場休市，不發送",
    };
  }

  if (plan.stance !== "enter") {
    // A withdrawal only makes sense for a trade that was announced, and
    // announcement now requires consensus — so the withdrawal checks the same
    // bar against the *previous* signal's own evidence. Without this, muting a
    // narrow trade would still let its disappearance ping the phone.
    // The trade you were told about, disappearing.
    //
    // Silence here is what made "telegram 有交易但網站沒有" a real complaint
    // rather than a misreading: the 08:54 sweep found A+ and announced it, the
    // next sweep found no-trade and said nothing, and the site — correctly
    // showing the newer row — had nothing to show. Nobody was wrong and nobody
    // was told. A recommendation that is withdrawn has to be withdrawn out
    // loud; that is the same duty that made it worth announcing.
    const prev = previous?.trade_plan;
    if (
      prev?.stance === "enter" &&
      previous !== null &&
      rank(previous.grade) >= rank(minGrade) &&
      breadthOf(previous.direction, previous.bias_items ?? []).agreeing.length >=
        MIN_CONSENSUS_DIMENSIONS
    ) {
      return { alert: true, reason: "先前的進場訊號已失效" };
    }
    return { alert: false, reason: "觀望，不發送" };
  }
  if (options.openTrade) {
    return {
      alert: false,
      reason: "此商品尚有追蹤中的未平倉交易，須先止盈或止損並記入復盤；新訊號僅顯示於網站",
    };
  }
  if (rank(current.grade) < rank(minGrade)) {
    return { alert: false, reason: `評等 ${current.grade} 低於門檻 ${minGrade}` };
  }
  // 一致性門檻。The grade measures how much evidence there is; this measures
  // how many independent dimensions it came from, and a phone interruption is
  // reserved for trades where at least three agree. Narrower trades still
  // exist, still store, still show on the site — the site is where you go
  // looking, the push is what comes looking for you, and those deserve
  // different bars. This is why the board can show a trade the phone never
  // mentioned: that is the design, not a missed message.
  const consensus = breadthOf(current.direction, current.bias_items ?? []);
  if (consensus.agreeing.length < MIN_CONSENSUS_DIMENSIONS) {
    return {
      alert: false,
      reason:
        `同向面向僅 ${consensus.agreeing.length} 個（推播需 ≥ ${MIN_CONSENSUS_DIMENSIONS}），` +
        `訊號僅顯示於網站`,
    };
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

  // A withdrawal is not a trade card with empty prices. It has one job — tell
  // you the thing you were told about is off — and printing 進場 — 停損 — over
  // it would read as a plan with missing numbers.
  if (plan.stance !== "enter") {
    // A withdrawal only makes sense for a trade that was announced, and
    // announcement now requires consensus — so the withdrawal checks the same
    // bar against the *previous* signal's own evidence. Without this, muting a
    // narrow trade would still let its disappearance ping the phone.
    const withdrawal = [
      `<b>${signal.symbol} 先前的進場訊號已失效</b>`,
      `本次掃描結果：${signal.grade}，${plan.wait_for ? "觀望" : "不進場"}`,
      "",
      plan.summary,
      plan.wait_for ? `等待條件：${plan.wait_for}` : null,
      "",
      `<i>觸發：${reason}</i>`,
    ];
    if (appUrl) withdrawal.push(appUrl);
    return withdrawal.filter((l) => l !== null).join("\n");
  }

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

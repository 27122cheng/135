import { breadthOf } from "@/lib/analysis/evidence";
import { SCALE_OUT_MIN_R } from "@/lib/analysis/lab-manage";
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

/**
 * Default push floor. Was "A" — a bar above the trading bar itself, which
 * produced the complaint that defined a month: the site holds B-grade
 * entries the scoring system explicitly declares tradeable, and the phone
 * never mentions any of them, so "one trade a month" was partly trades that
 * happened where nobody was told to look. The push floor now matches the
 * entry floor: if the rules would take it, the phone hears about it.
 * ALERT_MIN_GRADE in settings tightens it back for anyone who prefers quiet.
 */
export const DEFAULT_MIN_GRADE: Grade = "B";

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
  /**
   * A category the route can dedupe against a persistent marker, for events
   * that keep being "true" without being *new*. shouldAlert is pure and has
   * no database, so it only names the category; the route decides the key.
   */
  dedupeCategory?: "held-weakened";
}

/**
 * How many dimensions must point the signal's way before it interrupts a phone.
 *
 * Was three of six — a bar set assuming six dimensions actually vote. In
 * practice several are dark on any given scan (no CFTC code on a custom
 * symbol, GDELT rate-limited, the calendar source down), so "three of six"
 * was routinely three-of-three-that-answered: unanimity dressed as
 * confluence, and one more reason the phone stayed silent for a month. Two
 * independent kinds of evidence is still a case rather than an indicator —
 * one dimension alone remains not enough — and the grade floor above already
 * did the quality gating this was doubling up on.
 */
export const MIN_CONSENSUS_DIMENSIONS = 2;

/**
 * 這個訊號值不值得吵你 —— the worthiness half of {@link shouldAlert}, on its own.
 *
 * `shouldAlert` answers two questions at once: is this signal worth a push at
 * all, and has anything *changed* since the last one. Only the first half is
 * a property of the signal, and three surfaces need it separately:
 *
 *  - the refresh route, deciding whether to announce a new signal;
 *  - the board, labelling a row the phone will never mention;
 *  - **the monitor**, which had no such check and is why this exists.
 *
 * The monitor pushed 已觸及進場價 for any non-paper plan, with no gate of any
 * kind. A signal the consensus bar had deliberately kept off the phone was
 * still tracked as a real plan, so the moment it filled the phone announced
 * its entry — and that was the first the reader had ever heard of the trade.
 * From the outside it looks exactly like 「交易跟進場同時」: there was no trade
 * announcement, so the fill *was* the announcement. Worse, the two channels
 * were contradicting each other about the same signal.
 *
 * The rule now is one rule: if you were never told to open the position, you
 * are not told about its entry, its add-ons, its trailing stop or its exit
 * either. It is still tracked, still journalled, still counted — 靜靜追蹤,
 * which is what the paper stream has always done.
 */
export function pushWorthiness(
  signal: Pick<TradeSignal, "trade_plan" | "grade" | "direction" | "bias_items">,
  minGrade: Grade = DEFAULT_MIN_GRADE,
): { worthy: boolean; reason: string | null } {
  const plan = signal.trade_plan;
  if (plan?.stance !== "enter") {
    return { worthy: false, reason: "本次為觀望，不是可進場的訊號" };
  }
  if (rank(signal.grade) < rank(minGrade)) {
    return { worthy: false, reason: `評等 ${signal.grade} 低於推播門檻 ${minGrade}` };
  }
  const agreeing = breadthOf(signal.direction, signal.bias_items ?? []).agreeing.length;
  if (agreeing < MIN_CONSENSUS_DIMENSIONS) {
    return {
      worthy: false,
      reason:
        `同向面向僅 ${agreeing} 個（推播需 ≥ ${MIN_CONSENSUS_DIMENSIONS}），` +
        `此訊號只在網站顯示，手機不會收到 —— 證據夠成立一筆交易，但還不夠打擾你`,
    };
  }
  if (plan.entry === null || plan.stop_loss === null || plan.take_profit === null) {
    return { worthy: false, reason: "進場計畫缺少價位，不發送" };
  }
  return { worthy: true, reason: null };
}

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
      // Two different messages hide behind one transition. A *pending* entry
      // that the new scan no longer supports is a cancelled order — 已失效 is
      // exactly right. But once the monitor has filled it, the same words read
      // as "your trade was cancelled", which is false: a trade in flight
      // outlives the signal that opened it, and only the exit rules (stop,
      // target, breakeven, structure) close it. The live sequence that forced
      // this: 已觸及進場價 at 20:16, followed minutes later by 先前的進場訊號
      // 已失效 — the reader asked, reasonably, why their filled trade was
      // "cancelled". It wasn't; the message just couldn't say so.
      if (options.openTrade) {
        // Named so the route can dedupe: a setup sitting right on the
        // geometry floor can flip enter→wait→enter→wait across consecutive
        // scans, and the "back to enter" edge is silently swallowed by the
        // openTrade suppression a few lines below — so every "back to wait"
        // edge looked, from here alone, exactly like the first one. Without a
        // route-level per-position dedupe this fires on every oscillation.
        return {
          alert: true,
          reason: "持倉中的進場論點已轉弱（僅通知，持倉不取消）",
          dedupeCategory: "held-weakened",
        };
      }
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

export function formatAlert(
  signal: TradeSignal,
  reason: string,
  appUrl?: string,
  options: {
    /** The monitor holds a filled, unresolved position on this symbol. */
    openTrade?: boolean;
    /** That position's stop currently in force, for the held-position notice. */
    activeStop?: number | null;
  } = {},
): string {
  const plan = signal.trade_plan;
  const dir = signal.direction === "long" ? "做多 ▲" : "做空 ▼";

  // A withdrawal is not a trade card with empty prices. It has one job — tell
  // you the thing you were told about is off — and printing 進場 — 停損 — over
  // it would read as a plan with missing numbers.
  if (plan.stance !== "enter") {
    // Held position: the analysis flipped, the trade did not. Say both, in
    // that order, or the reader concludes their filled trade was cancelled —
    // see the matching branch in shouldAlert.
    if (options.openTrade) {
      const held = [
        `<b>${signal.symbol} 分析已轉觀望 —— 持倉不受影響</b>`,
        `你已進場的部位<b>不會</b>因重新掃描而取消。持倉由出場規則管理` +
          `（停損／停利／保本移停／結構移停／反向 CHoCH 出場），監控持續追蹤中` +
          (options.activeStop != null ? `，目前停損 ${fmt(options.activeStop)}` : "") +
          `。`,
        `本次掃描（${signal.grade}）已不再支持新開倉 —— 這則通知的意義是：進場當時的論點轉弱了，` +
          `可自行考慮收緊停損或減碼，但系統沒有、也不會替你平倉。`,
        "",
        plan.summary,
        "",
        `<i>觸發：${reason}</i>`,
      ];
      if (appUrl) held.push(appUrl);
      return held.filter((l) => l !== null).join("\n");
    }
    // A withdrawal only makes sense for a trade that was announced, and
    // announcement now requires consensus — so the withdrawal checks the same
    // bar against the *previous* signal's own evidence. Without this, muting a
    // narrow trade would still let its disappearance ping the phone.
    const withdrawal = [
      `<b>${signal.symbol} 先前的進場訊號已失效</b>`,
      `此訊號尚未成交，視為取消掛單。本次掃描結果：${signal.grade}，${plan.wait_for ? "觀望" : "不進場"}`,
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
    `當沖：進場 <b>${fmt(plan.entry)}</b>`,
    `停損 ${fmt(plan.stop_loss)}　停利 ${fmt(plan.take_profit)}`,
    plan.risk_reward !== null ? `風報比 1:${plan.risk_reward}` : null,
    // The evidence rides with the recommendation. A push that names three
    // prices without its sample asks to be trusted; this one shows the
    // managed backtest that let the plan through the floors.
    signal.plan_backtest && signal.plan_backtest.resolved > 0
      ? `實測：${
          signal.plan_backtest.expectancyR !== null
            ? `期望值 ${signal.plan_backtest.expectancyR > 0 ? "+" : ""}${signal.plan_backtest.expectancyR}R・`
            : ""
        }${
          signal.plan_backtest.hitRate !== null
            ? `勝率 ${Math.round(signal.plan_backtest.hitRate * 100)}%・`
            : ""
        }${signal.plan_backtest.resolved} 筆（含交易管理與成本）`
      : null,
    // And the lifecycle, so the reader enters knowing every branch — the
    // same rules the monitor executes and the backtest measured. Which
    // target branch applies depends on this plan's own geometry.
    `進場後：${
      plan.entry !== null &&
      plan.stop_loss !== null &&
      plan.take_profit !== null &&
      Math.abs(plan.entry - plan.stop_loss) > 0 &&
      Math.abs(plan.take_profit - plan.entry) / Math.abs(plan.entry - plan.stop_loss) >=
        SCALE_OUT_MIN_R
        ? "觸及停利先平一半保本追蹤"
        : "觸及停利整筆出場"
    }｜2R 保本｜新 swing 移停｜反向 CHoCH 出場（監控自動提醒）`,
    // The swing variant rides along as levels, never as a second monitored
    // trade — one position at a time is the monitor's rule, so the message
    // says which plan the tracking follows.
    ...(plan.swing
      ? [
          "",
          `波段（同方向，較大時間框架）：進場 ${fmt(plan.swing.entry)}`,
          `停損 ${fmt(plan.swing.stop_loss)}　停利 ${fmt(plan.swing.take_profit)}　風報比 1:${plan.swing.risk_reward}` +
            (plan.swing.hit_rate !== null
              ? `（回測勝率 ${Math.round(plan.swing.hit_rate * 100)}%）`
              : ""),
          `監控與復盤只追蹤當沖主計畫`,
        ]
      : []),
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

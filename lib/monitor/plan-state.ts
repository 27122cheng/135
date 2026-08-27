import type { AddOnLevel, TradePlan } from "@/types/signal";

/**
 * What the price has done to an active plan.
 *
 * Runs every 5 minutes against a *delayed* price (the free tier is EOD or
 * ~15 minutes behind — see lib/data-sources/yfinance.ts). That is fine for
 * managing an H4/D1 setup, where the levels are hours apart, and useless for
 * anything intraday. Nothing here pretends otherwise: the alert says how old
 * the price was.
 *
 * Pure function of (plan, price, last reported state). No fetching and no
 * database, so every transition rule below is directly testable.
 */

export type PlanState =
  | "waiting"      // price hasn't reached the entry
  | "entered"      // entry touched, position assumed open
  | "added"        // at least one add-on level reached
  | "scaled"       // first target banked half; the remainder trails at ≥ breakeven
  | "stop_hit"
  | "target_hit"
  | "structure_exit" // closed at market on an opposite structure break
  | "invalidated"; // the plan is no longer the current recommendation

export interface MonitorMemory {
  state: PlanState;
  /** Highest add-on sequence already announced. 0 = none. */
  addOnsFilled: number;
  /** Stop currently in force, including add-on adjustments. */
  activeStop: number | null;
}

export const INITIAL_MEMORY: MonitorMemory = {
  state: "waiting",
  addOnsFilled: 0,
  activeStop: null,
};

export interface MonitorInput {
  direction: "long" | "short";
  plan: TradePlan;
  price: number;
  /** How stale the price is, in minutes — reported, never hidden. */
  priceAgeMinutes: number;
  memory: MonitorMemory;
  /**
   * 結構式管理 — what the daily structure currently says, computed by the
   * caller from D1 candles (the same anchors the lab's exit engine uses).
   * Optional: without it the plan is managed exactly as before (levels +
   * breakeven), so a candle outage degrades the management, never the
   * level-watching.
   */
  structure?: {
    /** Suggested trailing stop (structure ± buffer), or null when none. */
    trailStop: number | null;
    /** An opposite CHoCH confirmed on the newest completed D1 bar. */
    flipped: boolean;
  } | null;
}

export interface MonitorEvent {
  kind:
    | "entered"
    | "add_on"
    | "stop_moved"
    | "stop_hit"
    | "target_hit"
    | "scale_out"
    | "structure_exit";
  headline: string;
  detail: string;
  /** The stop that should now be in force, when this event changes it. */
  newStop: number | null;
}

export interface MonitorResult {
  memory: MonitorMemory;
  /** Empty when nothing changed — the common case, and it must stay silent. */
  events: MonitorEvent[];
}

function reached(direction: "long" | "short", price: number, level: number): boolean {
  return direction === "long" ? price >= level : price <= level;
}

/**
 * A fill, not a breakout.
 *
 * The plans' entries are pullback levels — buy the dip at structure, sell the
 * bounce — so the entry is a limit order: a long fills when price comes *down*
 * to it, a short when price comes *up* to it. The first cut reused `reached`,
 * which is profit-side logic (right for add-ons and targets), and so it
 * "filled" a long the moment price was anywhere ABOVE the entry. Any stale
 * plan whose levels sat below a risen market instantly booked entry and
 * take-profit in the same tick at the same price — a fictional winning trade,
 * pushed to Telegram and written to the journal as a 停利. With fill logic the
 * same tick cannot do both: a long that fills at-or-below entry cannot
 * simultaneously be at-or-above a target that sits higher.
 */
function entryFilled(direction: "long" | "short", price: number, entry: number): boolean {
  return direction === "long" ? price <= entry : price >= entry;
}

function stopBreached(direction: "long" | "short", price: number, stop: number): boolean {
  return direction === "long" ? price <= stop : price >= stop;
}

function fmt(n: number): string {
  return Math.abs(n) < 10 ? n.toFixed(5) : n.toFixed(2);
}

/**
 * Advances the plan's state given the latest price.
 *
 * Order matters: the stop is checked before add-ons, so a bar that ran through
 * both reports the stop rather than congratulating the user on an add-on they
 * were never filled on. With delayed 5-minute data we cannot know the intrabar
 * sequence, so the pessimistic reading is the only honest one.
 */
export function advancePlan(input: MonitorInput): MonitorResult {
  const { direction, plan, price, memory } = input;
  const events: MonitorEvent[] = [];

  // Terminal states stay terminal until a new plan replaces the row.
  if (
    memory.state === "stop_hit" ||
    memory.state === "target_hit" ||
    memory.state === "structure_exit"
  ) {
    return { memory, events };
  }
  if (plan.stance !== "enter" || plan.entry === null || plan.stop_loss === null) {
    return { memory, events };
  }

  let state = memory.state;
  let addOnsFilled = memory.addOnsFilled;
  let activeStop = memory.activeStop ?? plan.stop_loss;

  if (state === "waiting") {
    if (!entryFilled(direction, price, plan.entry)) {
      return { memory: { state, addOnsFilled, activeStop }, events };
    }
    state = "entered";
    events.push({
      kind: "entered",
      headline: "已觸及進場價",
      detail: `價格 ${fmt(price)} 觸及進場 ${fmt(plan.entry)}，停損 ${fmt(activeStop)}`,
      newStop: activeStop,
    });
  }

  // Checked first — see the note above about intrabar ordering.
  if (stopBreached(direction, price, activeStop)) {
    return {
      memory: { state: "stop_hit", addOnsFilled, activeStop },
      events: [
        ...events,
        {
          kind: "stop_hit",
          headline: state === "scaled" ? "剩餘半倉停損觸及" : "停損觸及",
          detail:
            state === "scaled"
              ? `價格 ${fmt(price)} 觸及停損 ${fmt(activeStop)}，剩餘半倉出場（前一半已在停利 ${plan.take_profit !== null ? fmt(plan.take_profit) : "—"} 落袋）。本次交易結束，請到 /review 記錄。`
              : `價格 ${fmt(price)} 觸及停損 ${fmt(activeStop)}，本次交易結束。請到 /review 記錄並選一個 S1–S8 停損原因。`,
          newStop: null,
        },
      ],
    };
  }

  // 分批止盈 — the first target banks half, not the whole position.
  //
  // Full exit at the first shelf was the amateur shape: every winner capped
  // at the nearest pressure while losers still cost a full R. Touching the
  // target now closes half, moves the remainder's stop to at least the entry
  // (the banked half has paid for the trade), and hands the rest to the
  // trailing/flip rules. Same rule the exit engine backtests, so the number
  // that chose this plan describes the trade actually being run.
  if (
    state !== "scaled" &&
    plan.take_profit !== null &&
    reached(direction, price, plan.take_profit)
  ) {
    state = "scaled";
    const banked = plan.take_profit;
    const toward =
      direction === "long"
        ? Math.max(activeStop, plan.entry)
        : Math.min(activeStop, plan.entry);
    const movedStop = toward !== activeStop;
    activeStop = toward;
    events.push({
      kind: "scale_out",
      headline: "觸及停利 —— 先平一半，剩餘保本追蹤",
      detail:
        `價格 ${fmt(price)} 觸及停利 ${fmt(banked)}：平掉一半部位落袋，` +
        `剩餘半倉停損${movedStop ? `移至進場價 ${fmt(plan.entry)}` : `維持 ${fmt(activeStop)}（已優於進場價）`}，` +
        `之後交由結構移停與反向 CHoCH 出場管理 —— 這半倉最差是打平，最好是跑出一段趨勢。`,
      newStop: activeStop,
    });
  }

  // 看法改變就出場 — an opposite CHoCH on the daily structure closes the
  // position at the market. Same rule the lab's exit engine applies, so the
  // live trade and the measured trade are the same trade. Checked after the
  // hard levels: a bar that actually ran through the stop reports the stop.
  // Only while a position is open — a waiting plan has nothing to close, and
  // the terminal check above makes this fire exactly once.
  if ((state === "entered" || state === "added" || state === "scaled") && input.structure?.flipped) {
    return {
      memory: { state: "structure_exit", addOnsFilled, activeStop },
      events: [
        ...events,
        {
          kind: "structure_exit",
          headline: state === "scaled" ? "結構翻轉，剩餘半倉出場" : "結構翻轉，出場",
          detail:
            `日線出現反向 CHoCH（結構翻轉），進場理由已不成立。` +
            `以現價 ${fmt(price)} ${state === "scaled" ? "將剩餘半倉出場（前一半已在停利落袋）" : "出場"}，不等停損 ${fmt(activeStop)} —— ` +
            `技術面看法改變時出場是管理規則的一部分，和回測量的是同一種交易。`,
          newStop: null,
        },
      ],
    };
  }

  // 保本移停 — at 1R in favour, the stop moves to the entry.
  //
  // The single biggest driver of the stop-out rate is trades that travel well
  // into profit and then return all the way to the original stop. Once price
  // has moved one full risk distance in the plan's favour, the market has paid
  // for the trade; from there the worst case becomes breakeven instead of −1R.
  // The cost is real and accepted: some winners get scratched at entry on a
  // pullback that would have recovered. That trade-off is the one every
  // risk-management text makes, and it cuts realised stop-outs directly.
  //
  // No new state is needed — the rule is naturally idempotent: it fires only
  // while the active stop is still on the risk side of the entry, and firing
  // moves the stop *to* the entry, so it can never fire twice. An add-on that
  // already lifted the stop past entry suppresses it the same way.
  if (
    (state === "entered" || state === "added") &&
    plan.take_profit !== null &&
    (direction === "long" ? activeStop < plan.entry : activeStop > plan.entry)
  ) {
    const risk = Math.abs(plan.entry - plan.stop_loss);
    const oneR = direction === "long" ? plan.entry + risk : plan.entry - risk;
    if (risk > 0 && reached(direction, price, oneR)) {
      activeStop = plan.entry;
      events.push({
        kind: "stop_moved",
        headline: "已達 1R，停損移至進場價（保本）",
        detail:
          `價格 ${fmt(price)} 已朝有利方向走完一個風險距離（1R = ${fmt(risk)}）。` +
          `停損由 ${fmt(memory.activeStop ?? plan.stop_loss)} 移至進場價 ${fmt(plan.entry)} —— ` +
          `這筆交易從此最差是打平。代價是回檔到進場價會被洗出場，那是保本規則接受的成本。`,
        newStop: plan.entry,
      });
    }
  }

  // 結構移停 — a newly confirmed swing on the daily chart steps the stop up
  // behind it, the same trailing rule the lab's exit engine runs. Toward
  // safety only, and never through the current price: a suggested stop on the
  // wrong side of the market would manufacture an exit out of thin air.
  if (state === "entered" || state === "added" || state === "scaled") {
    const trail = input.structure?.trailStop;
    if (trail != null && Number.isFinite(trail)) {
      const improves =
        direction === "long" ? trail > activeStop && trail < price : trail < activeStop && trail > price;
      if (improves) {
        activeStop = trail;
        events.push({
          kind: "stop_moved",
          headline: "結構移停",
          detail:
            `日線確認了新的 swing 結構，停損上移到結構外 ${fmt(trail)} —— ` +
            `跟著結構走的移動停損，和回測用的是同一條規則。`,
          newStop: trail,
        });
      }
    }
  }

  // Add-ons fire in order. Skipping straight to level 3 on a gap would announce
  // fills at prices that were never offered in sequence, so each is reported.
  // A scaled position is in harvest mode — half is already banked and the
  // remainder is being trailed out, so adding size back on is off the table.
  const pending: AddOnLevel[] =
    state === "scaled"
      ? []
      : plan.add_ons
          .filter((level) => level.sequence > addOnsFilled)
          .sort((a, b) => a.sequence - b.sequence);

  for (const level of pending) {
    if (!reached(direction, price, level.price)) break;
    addOnsFilled = level.sequence;
    state = "added";
    events.push({
      kind: "add_on",
      headline: `第 ${level.sequence} 段加倉點到達`,
      detail: `${fmt(level.price)}｜${level.reason}`,
      newStop: null,
    });
    // The stop moves with every add-on. This is the part that must not be
    // skipped: more size on the same stop is more risk on a trade that has
    // already paid. But it may only ever move toward safety — the breakeven
    // rule can have already lifted the stop past the add-on's suggestion, and
    // "adjusting" it back to the risk side would be the one thing no rule in
    // this file is allowed to do. The tighter of the two stands.
    const improves =
      direction === "long"
        ? level.new_stop_loss > activeStop
        : level.new_stop_loss < activeStop;
    if (improves) {
      activeStop = level.new_stop_loss;
      events.push({
        kind: "stop_moved",
        headline: "停損上移",
        detail: `${fmt(level.new_stop_loss)}｜${level.new_stop_reason}${
          level.locks_in_entry ? "（已保住進場價）" : ""
        }`,
        newStop: level.new_stop_loss,
      });
    }
  }

  return { memory: { state, addOnsFilled, activeStop }, events };
}

/** Telegram-flavoured message for one run's events on one symbol. */
export function formatMonitorAlert(
  symbol: string,
  direction: "long" | "short",
  events: MonitorEvent[],
  priceAgeMinutes: number,
  appUrl?: string,
  context: {
    /** The tracked plan's entry, so every push names the trade it belongs to. */
    entry?: number | null;
    /** When the tracked plan was generated (ISO), for the same reason. */
    generatedAt?: string | null;
    /**
     * Whether the *newest* analysis still supports this position's direction.
     * The monitor manages the snapshot it entered on — that is the standing
     * rule — but an add-on is the one action that increases risk, and a
     * suggestion to add days after the analysis flipped reads as the system
     * contradicting itself ("沒有交易建議怎麼突然要我加倉"). When this is
     * false, an add-on level is reported as reached, with the advice not to
     * act on it; the stop moves are unaffected — they only ever reduce risk.
     */
    analysisSupports?: boolean;
  } = {},
): string {
  const lines = [`<b>${symbol} ${direction === "long" ? "做多 ▲" : "做空 ▼"}</b>`];

  // Which trade this is about. A push that names a level without naming the
  // position it belongs to reads as a recommendation out of nowhere —
  // especially days after the entry, when the reader has lost the thread.
  if (context.entry != null && Number.isFinite(context.entry)) {
    const when = context.generatedAt ? `（${context.generatedAt.slice(5, 10)} 的訊號）` : "";
    lines.push(`追蹤中的持倉：進場 ${fmt(context.entry)}${when}`);
  }

  lines.push(...events.flatMap((e) => [`<b>${e.headline}</b>`, e.detail]));

  if (context.analysisSupports === false && events.some((e) => e.kind === "add_on")) {
    lines.push(
      `⚠ 最新一輪分析已轉觀望，<b>不建議執行這次加倉</b> —— 加倉是唯一會增加風險的動作，` +
        `只在最新分析仍支持這個方向時才值得做。停損上移照常執行，持倉本身不受影響。`,
    );
  }

  lines.push(
    "",
    `<i>價格延遲約 ${Math.round(priceAgeMinutes)} 分鐘（免費資料源），僅適用 H4/D1 級別的部位管理</i>`,
  );
  if (appUrl) lines.push(appUrl);
  return lines.join("\n");
}

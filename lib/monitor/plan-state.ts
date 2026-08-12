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
  | "stop_hit"
  | "target_hit"
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
}

export interface MonitorEvent {
  kind: "entered" | "add_on" | "stop_moved" | "stop_hit" | "target_hit";
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
  if (memory.state === "stop_hit" || memory.state === "target_hit") {
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
          headline: "停損觸及",
          detail: `價格 ${fmt(price)} 觸及停損 ${fmt(activeStop)}，本次交易結束。請到 /review 記錄並選一個 S1–S8 停損原因。`,
          newStop: null,
        },
      ],
    };
  }

  if (plan.take_profit !== null && reached(direction, price, plan.take_profit)) {
    return {
      memory: { state: "target_hit", addOnsFilled, activeStop },
      events: [
        ...events,
        {
          kind: "target_hit",
          headline: "停利觸及",
          detail: `價格 ${fmt(price)} 觸及停利 ${fmt(plan.take_profit)}。請到 /review 記錄這筆交易。`,
          newStop: null,
        },
      ],
    };
  }

  // Add-ons fire in order. Skipping straight to level 3 on a gap would announce
  // fills at prices that were never offered in sequence, so each is reported.
  const pending: AddOnLevel[] = plan.add_ons
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
    // already paid.
    if (level.new_stop_loss !== activeStop) {
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
): string {
  const lines = [
    `<b>${symbol} ${direction === "long" ? "做多 ▲" : "做空 ▼"}</b>`,
    ...events.flatMap((e) => [`<b>${e.headline}</b>`, e.detail]),
    "",
    `<i>價格延遲約 ${Math.round(priceAgeMinutes)} 分鐘（免費資料源），僅適用 H4/D1 級別的部位管理</i>`,
  ];
  if (appUrl) lines.push(appUrl);
  return lines.join("\n");
}

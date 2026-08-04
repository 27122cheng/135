import type { AddOnLevel, EntryStructure, PathObstacle } from "@/types/signal";

/**
 * 加倉 — where to add, and what the stop becomes when you do.
 *
 * Two rules from the spec shape everything here:
 *
 *  - **不能用幾 R 來分配.** An add-on at "+1R" is a price the market has never
 *    traded against and has no reason to respect. Every level below sits on a
 *    structure the analysis already found: a path obstacle the trade has broken
 *    through (which then acts as support in the trade direction), or a
 *    protecting structure beyond the entry.
 *  - **加倉時需要調整止損.** Each level carries the stop the *whole* position
 *    moves to. Adding size while leaving the stop where it was increases risk
 *    on a trade that has already paid — the one thing scaling in must not do.
 *    A level whose new stop can't be anchored to a real structure is dropped
 *    rather than shipped with a made-up number.
 *
 * At most three, per the spec.
 */

const MAX_ADD_ONS = 3;

/**
 * Levels must be meaningfully apart. Two add-ons 0.1% apart are one add-on
 * with extra steps, and they'd both fill on the same candle.
 */
function minSeparation(price: number, atr: number | null): number {
  return atr && atr > 0 ? atr * 0.5 : price * 0.004;
}

function round(n: number): number {
  return Math.round(n * 100000) / 100000;
}

export interface AddOnInput {
  direction: "long" | "short";
  entry: number;
  /** The plan's original stop — the new stops must never be worse than this. */
  stopLoss: number;
  takeProfit: number;
  entryStructures: EntryStructure[];
  pathObstacles: PathObstacle[];
  atr: number | null;
}

/** Structures that could hold price up (long) or down (short) at `level`. */
function protectingStructuresBelow(
  input: AddOnInput,
  level: number,
): Array<{ price: number; label: string }> {
  const { direction } = input;
  const fromEntry = input.entryStructures
    .filter((s) => (direction === "long" ? s.role === "support" : s.role === "resistance"))
    .filter((s) => (direction === "long" ? s.price < level : s.price > level))
    .map((s) => ({ price: s.price, label: `${s.timeframe} ${s.type} @ ${s.price}` }));

  // An obstacle the trade has already traded through flips role: a broken
  // resistance is support on the retest. That's the classic add-on anchor.
  const broken = input.pathObstacles
    .filter((o) => (direction === "long" ? o.price < level : o.price > level))
    .filter((o) => (direction === "long" ? o.price > input.entry : o.price < input.entry))
    .map((o) => ({ price: o.price, label: `已突破的 ${o.timeframe} ${o.type} @ ${o.price}（角色反轉）` }));

  return [...fromEntry, ...broken].sort((a, b) =>
    direction === "long" ? b.price - a.price : a.price - b.price,
  );
}

/**
 * Builds up to three scale-in levels. Returns [] when the structures don't
 * support adding — which is a normal outcome, not a failure.
 */
export function buildAddOns(input: AddOnInput): AddOnLevel[] {
  const { direction, entry, takeProfit, atr } = input;
  const ahead = (a: number, b: number) => (direction === "long" ? a > b : a < b);

  // Candidates are obstacles between the entry and the target: the trade has
  // to break through them, and each break is a place the move has proven
  // itself. Anything at or beyond the target is not an add-on, it's an exit.
  const candidates = input.pathObstacles
    .filter((o) => ahead(o.price, entry) && ahead(takeProfit, o.price))
    .sort((a, b) => (direction === "long" ? a.price - b.price : b.price - a.price));

  const levels: AddOnLevel[] = [];
  let previous = entry;

  for (const obstacle of candidates) {
    if (levels.length >= MAX_ADD_ONS) break;
    if (Math.abs(obstacle.price - previous) < minSeparation(entry, atr)) continue;

    // The stop for the enlarged position: the nearest real structure behind
    // this level. No structure → no add-on. We don't invent a stop.
    const protectors = protectingStructuresBelow(input, obstacle.price);
    const anchor = protectors[0];
    if (!anchor) continue;

    const buffer = atr && atr > 0 ? atr * 0.5 : 0;
    const newStop = direction === "long" ? anchor.price - buffer : anchor.price + buffer;

    // Never move the stop the wrong way. On the first add-on the original stop
    // may still be the better one; taking the worse of the two would quietly
    // widen risk at the exact moment size is increasing.
    const improved = ahead(newStop, input.stopLoss);
    if (!improved) continue;
    // A stop beyond the add-on level itself would be stopped out instantly.
    if (!ahead(obstacle.price, newStop)) continue;

    const sequence = (levels.length + 1) as 1 | 2 | 3;
    levels.push({
      sequence,
      price: round(obstacle.price),
      structure: `${obstacle.timeframe} ${obstacle.type} @ ${obstacle.price}`,
      reason:
        `價格突破並站穩 ${obstacle.timeframe} ${obstacle.type}（強度 ${obstacle.strength}）後加倉，` +
        `此處是走勢已經證明自己的位置，不是用倍數推算出來的價格`,
      new_stop_loss: round(newStop),
      new_stop_reason:
        `整體部位停損移到 ${anchor.label}${buffer ? ` 之外再扣 0.5×ATR ${round(buffer)}` : ""}`,
      locks_in_entry: ahead(newStop, entry) || newStop === entry,
    });
    previous = obstacle.price;
  }

  return levels;
}

import type { AddOnLevel, EntryStructure, Grade, PathObstacle } from "@/types/signal";

/**
 * 加倉 — where to add, and what the stop becomes when you do.
 *
 * Four rules, all of them refusals rather than formulas:
 *
 *  1. **方向要有信心.** Adding size is a bet that the existing direction keeps
 *     working. Only A/A+ qualify — those are exactly the grades whose bias
 *     score cleared the conviction bar in lib/scoring.ts. On a B or C the
 *     original entry is already the speculative part; doubling it is worse.
 *  2. **加倉點必須本身有支撐（做多）／壓力（做空）.** A level is only support
 *     once price is above it, so an add-on is a *retest*: price breaks the
 *     level, advances, comes back, and the level holds from the other side.
 *     Note that `role` in EntryStructure is assigned relative to the *current*
 *     price, so nothing above a long's entry is ever labelled "support" —
 *     which is why the qualifying evidence is the level's own strength, not
 *     its role field.
 *  3. **結構要夠強.** Strength ≥ 2 means the level was touched at least twice,
 *     or sits on the daily/weekly, or shows cross-timeframe confluence (see
 *     lib/analysis/levels.ts). A single untested swing high is not 支撐 — it
 *     is a line someone drew once.
 *  4. **不能用幾 R 來分配.** An add-on at "+1R" is a price the market has never
 *     traded against. Every level here is one the analysis already found.
 *
 * Plus: each level carries the stop the *whole* position moves to. Adding size
 * while leaving the stop put increases risk on a trade that has already paid.
 */

const MAX_ADD_ONS = 3;

/** Grades whose directional conviction is strong enough to add to. */
const CONFIDENT_GRADES: ReadonlySet<Grade> = new Set<Grade>(["A+", "A"]);

/** A level worth adding on must have held more than once. */
const MIN_STRUCTURE_STRENGTH = 2;

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
  /** Gates whether adding is permitted at all — see rule 1. */
  grade: Grade;
  entry: number;
  /** The plan's original stop — the new stops must never be worse than this. */
  stopLoss: number;
  takeProfit: number;
  entryStructures: EntryStructure[];
  pathObstacles: PathObstacle[];
  atr: number | null;
}

export interface AddOnResult {
  levels: AddOnLevel[];
  /** Why there are none, when there are none. Null when levels were produced. */
  skipped: string | null;
}

/** Structures that could hold price at `level` once the trade is beyond it. */
function protectingStructuresBehind(
  input: AddOnInput,
  level: number,
): Array<{ price: number; label: string }> {
  const { direction } = input;
  const fromEntry = input.entryStructures
    .filter((s) => (direction === "long" ? s.price < level : s.price > level))
    .map((s) => ({ price: s.price, label: `${s.timeframe} ${s.type} @ ${s.price}` }));

  const behindObstacles = input.pathObstacles
    .filter((o) => (direction === "long" ? o.price < level : o.price > level))
    .filter((o) => (direction === "long" ? o.price > input.entry : o.price < input.entry))
    .filter((o) => o.strength >= MIN_STRUCTURE_STRENGTH)
    .map((o) => ({ price: o.price, label: `${o.timeframe} ${o.type} @ ${o.price}` }));

  return [...fromEntry, ...behindObstacles].sort((a, b) =>
    direction === "long" ? b.price - a.price : a.price - b.price,
  );
}

/**
 * Builds up to three scale-in levels. An empty list is a normal outcome — it
 * means the structures don't justify adding, which is information, not a gap
 * to be filled with an invented price.
 */
export function buildAddOns(input: AddOnInput): AddOnResult {
  const { direction, entry, takeProfit, atr, grade } = input;

  if (!CONFIDENT_GRADES.has(grade)) {
    return {
      levels: [],
      skipped: `評等 ${grade} 對方向的信心不足以加倉（僅 A / A+ 提供加倉點）`,
    };
  }

  const ahead = (a: number, b: number) => (direction === "long" ? a > b : a < b);
  const side = direction === "long" ? "支撐" : "壓力";

  // Candidates sit between the entry and the target, in the trade direction.
  // Anything at or beyond the target is an exit, not an add-on.
  const inRange = input.pathObstacles.filter(
    (o) => ahead(o.price, entry) && ahead(takeProfit, o.price),
  );
  if (inRange.length === 0) {
    return { levels: [], skipped: "進場到停利之間沒有可錨定的結構" };
  }

  // Rule 3: only levels the market has actually defended. A strength-1 level
  // has been touched once and proves nothing about holding a retest.
  const strongEnough = inRange
    .filter((o) => o.strength >= MIN_STRUCTURE_STRENGTH)
    .sort((a, b) => (direction === "long" ? a.price - b.price : b.price - a.price));

  if (strongEnough.length === 0) {
    return {
      levels: [],
      skipped: `進場到停利之間的結構強度都只有 1（單次觸及），回測時不足以構成${side}，不提供加倉點`,
    };
  }

  const levels: AddOnLevel[] = [];
  let previous = entry;

  for (const obstacle of strongEnough) {
    if (levels.length >= MAX_ADD_ONS) break;
    if (Math.abs(obstacle.price - previous) < minSeparation(entry, atr)) continue;

    // The stop for the enlarged position: the nearest real structure behind
    // this level. No structure → no add-on. We don't invent a stop.
    const anchor = protectingStructuresBehind(input, obstacle.price)[0];
    if (!anchor) continue;

    const buffer = atr && atr > 0 ? atr * 0.5 : 0;
    const newStop = direction === "long" ? anchor.price - buffer : anchor.price + buffer;

    // Never move the stop the wrong way. Taking the worse of the two would
    // quietly widen risk at the exact moment size is increasing.
    if (!ahead(newStop, input.stopLoss)) continue;
    // A stop beyond the add-on level itself would be stopped out instantly.
    if (!ahead(obstacle.price, newStop)) continue;

    const sequence = (levels.length + 1) as 1 | 2 | 3;
    levels.push({
      sequence,
      price: round(obstacle.price),
      structure: `${obstacle.timeframe} ${obstacle.type} @ ${obstacle.price}`,
      reason:
        `價格突破 ${obstacle.timeframe} ${obstacle.type} 後回測此處加倉：` +
        `該價位為強度 ${obstacle.strength} 的結構（多次觸及或跨時框共振），` +
        `回測時位於價格${direction === "long" ? "下方" : "上方"}、具${side}性質。` +
        `此處是走勢已經證明過的位置，不是用倍數推算出來的價格`,
      new_stop_loss: round(newStop),
      new_stop_reason:
        `整體部位停損移到 ${anchor.label}${buffer ? ` 之外再扣 0.5×ATR ${round(buffer)}` : ""}`,
      locks_in_entry: ahead(newStop, entry) || newStop === entry,
    });
    previous = obstacle.price;
  }

  if (levels.length === 0) {
    return {
      levels: [],
      skipped: `找到${side}結構，但其後方沒有可錨定的保護結構可供調整停損，不提供加倉點`,
    };
  }
  return { levels, skipped: null };
}

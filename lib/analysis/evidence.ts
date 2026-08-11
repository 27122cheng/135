import type { BiasDimension, BiasItem } from "@/types/signal";

/**
 * 證據去重 — one fact, one vote.
 *
 * ## The bug this exists for
 *
 * `bias_score` sums every item's weight. That is only sound if every item is a
 * *different* fact. It wasn't. Two analyzers were reading the same FRED series
 * and both filing a bias item:
 *
 * ```
 * 基本面  VIX=27.4 風險趨避情緒偏高      direction=short  weight=1
 * 資金流  VIX=27.4 風險趨避提升拋售壓力   direction=short  weight=1
 * ```
 *
 * Same series, same thresholds (≥25 / ≤14), same direction rule, same weight.
 * One number, two votes. DXY was the same story with two different lookback
 * windows. On a symbol using both, that is up to +2 of manufactured conviction
 * against an A threshold of 6 — a third of the bar, from counting two numbers
 * twice.
 *
 * ## The fix
 *
 * Every item declares a `key`: what is being *measured*, not where it was
 * measured from. Items sharing a key are one fact, and collapse to one vote.
 *
 * Collapsing keeps the disagreement rather than picking a winner. When the
 * 5-day dollar trend opposes the 20-day one, that is not a coin toss to be
 * resolved by list order — it is genuine ambiguity, and the merged item comes
 * out neutral, contributing zero. Two readings that agree keep the heavier
 * weight, not the sum: agreeing with yourself is not corroboration.
 *
 * ## What this is not
 *
 * Not a correlation model. It only catches items that measure literally the
 * same quantity. DXY and the US real rate are highly correlated and both still
 * vote — they are different measurements, and pretending otherwise would need a
 * covariance estimate this system has no way to justify. Breadth across
 * dimensions is priced separately, in the confidence score, where an
 * over-concentrated case can be marked down without silently deleting evidence.
 */

/** Merged item plus the trail of what went into it. */
export interface DedupeResult {
  items: BiasItem[];
  /** One line per collapsed group, for data_gaps. Empty when nothing merged. */
  notes: string[];
}

function keyOf(item: BiasItem): string {
  // Falling back to dimension+factor means an analyzer that forgets to set a
  // key still can't be double-counted by accident with itself, and never
  // silently merges with a different measurement.
  return item.key ?? `${item.dimension}|${item.factor}`;
}

/**
 * Net direction of a group, by weight. Null when they cancel — which is the
 * honest answer for two readings of one quantity that point opposite ways.
 */
function netOf(group: BiasItem[]): "long" | "short" | "neutral" {
  const net = group.reduce((sum, i) => {
    if (i.direction === "long") return sum + i.weight;
    if (i.direction === "short") return sum - i.weight;
    return sum;
  }, 0);
  return net > 0 ? "long" : net < 0 ? "short" : "neutral";
}

export function dedupeBiasItems(items: BiasItem[]): DedupeResult {
  const groups = new Map<string, BiasItem[]>();
  const order: string[] = [];
  for (const item of items) {
    const k = keyOf(item);
    const existing = groups.get(k);
    if (existing) existing.push(item);
    else {
      groups.set(k, [item]);
      order.push(k);
    }
  }

  const out: BiasItem[] = [];
  const notes: string[] = [];

  for (const k of order) {
    const group = groups.get(k)!;
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }

    // The heaviest reading carries the merged item — not the sum. Two views of
    // one number are one number.
    const lead = group.reduce((best, i) => (i.weight > best.weight ? i : best));
    const direction = netOf(group);
    const others = group.filter((i) => i !== lead);
    const disagree = direction === "neutral" && group.some((i) => i.direction !== "neutral");

    out.push({
      ...lead,
      direction,
      factor: disagree
        ? `${lead.factor}（同一項指標的另一組讀數方向相反，合併後不計方向）`
        : `${lead.factor}（另有 ${others.length} 項同源讀數，已合併為一票）`,
      evidence:
        `${lead.evidence}｜同源：` + others.map((i) => `${i.dimension} ${i.evidence}`).join("、"),
    });

    const dims = [...new Set(group.map((i) => i.dimension))];
    notes.push(
      disagree
        ? `「${k}」有 ${group.length} 組讀數且方向相反（${group.map((i) => `${i.dimension}:${i.direction}`).join("、")}），合併後視為中性`
        : dims.length > 1
          ? `「${k}」被 ${dims.length} 個面向重複計入（${dims.join("、")}），已合併為一票`
          : `「${k}」在${dims[0]}內重複產生 ${group.length} 筆同源讀數，已合併為一票`,
    );
  }

  return { items: out, notes };
}

/**
 * How broadly the evidence agrees, by dimension.
 *
 * Deliberately *not* fed into the grade. `bias_score` measures how much
 * evidence there is; this measures how many independent places it came from,
 * and they are different questions with the same answer far too often for one
 * number to carry both. Six points from 技術面 alone and six points spread over
 * three dimensions grade identically and are not the same trade — the second is
 * a case, the first is one indicator repeated.
 *
 * So it goes to the confidence score instead, where it can rank without
 * suppressing: a concentrated setup still trades, it just doesn't claim the
 * conviction of a broad one.
 */
export interface Breadth {
  /** Dimensions whose net weight points the signal's way. */
  agreeing: BiasDimension[];
  /** Dimensions actively pointing the other way. */
  opposing: BiasDimension[];
  /** Dimensions that produced only weight-0 or cancelling items. */
  silent: BiasDimension[];
}

export function breadthOf(direction: "long" | "short", items: BiasItem[]): Breadth {
  const nets = new Map<BiasDimension, number>();
  for (const i of items) {
    const delta = i.direction === "long" ? i.weight : i.direction === "short" ? -i.weight : 0;
    nets.set(i.dimension, (nets.get(i.dimension) ?? 0) + delta);
  }

  const agreeing: BiasDimension[] = [];
  const opposing: BiasDimension[] = [];
  const silent: BiasDimension[] = [];
  for (const [dimension, net] of nets) {
    const towards = direction === "long" ? net : -net;
    if (towards > 0) agreeing.push(dimension);
    else if (towards < 0) opposing.push(dimension);
    else silent.push(dimension);
  }
  return { agreeing, opposing, silent };
}

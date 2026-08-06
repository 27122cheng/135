import { COMMODITIES, type AddOnLevel, type Grade, type SignalRow } from "@/types/signal";

export interface BoardAddOn {
  sequence: number;
  price: number;
  structure: string;
  new_stop_loss: number;
}

/**
 * The levels the analysis computed, whether or not they became a trade.
 *
 * `trade_plan` goes empty the moment the rules stand aside — that is correct,
 * because a plan is a recommendation and there isn't one. But the entry zone,
 * the stop structure and the targets were still derived from real structure,
 * and a row that opens to the single word 觀望 throws all of it away. The
 * detail page has always shown these under 參考價位（未達可交易門檻）; this
 * carries the same three fields to the board so opening a row without a trade
 * still tells you where the interesting prices are.
 *
 * Kept separate from the plan's `entry`/`stopLoss`/`takeProfit` rather than
 * merged into them. They are different claims — one is "take this", the other
 * is "this is what the structure says" — and collapsing them is exactly how a
 * reference number gets read as a signal.
 */
export interface BoardReference {
  entryLow: number;
  entryHigh: number;
  entryReason: string;
  stopLoss: number;
  stopReason: string;
  takeProfits: { price: number; allocationPct: number; structure: string }[];
}

export interface BoardRow {
  symbol: string;
  label: string;
  category: string;
  /** Null when this symbol has never been scanned. */
  signalId: string | null;
  direction: "long" | "short" | null;
  /** True when the factors cancelled out — show 中性, not a direction. */
  directionTie: boolean;
  grade: Grade | null;
  /** "enter" is the only one that means there is a trade. */
  stance: "enter" | "wait" | null;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskReward: number | null;
  /** The stored 信心度 score, or null for a signal written before it existed. */
  confidence: number | null;
  addOns: BoardAddOn[];
  summary: string | null;
  waitFor: string | null;
  /**
   * Structure-derived levels, present on every scanned row including the ones
   * that stood aside. Null only when the symbol has never been scanned.
   */
  reference: BoardReference | null;
  generatedAt: string | null;
  /** How many data gaps the scan reported — a count, not the list. */
  gapCount: number;
}

/**
 * Defensive on purpose: these come back as a JSON blob from the database, and
 * rows written by earlier versions of the builder are not guaranteed to have
 * every field the current type claims. A board that throws because one stored
 * signal predates a field is worse than one that shows eight rows and a gap.
 */
export function toReference(row: SignalRow): BoardReference | null {
  const zone = row.entry_zone;
  const sl = row.stop_loss;
  if (!zone || !sl || !Number.isFinite(sl.price)) return null;
  return {
    entryLow: zone.low,
    entryHigh: zone.high,
    entryReason: zone.reason,
    stopLoss: sl.price,
    stopReason: sl.structure,
    takeProfits: (row.take_profits ?? [])
      .filter((tp) => Number.isFinite(tp?.price))
      .map((tp) => ({
        price: tp.price,
        allocationPct: tp.allocation_pct,
        structure: tp.structure,
      })),
  };
}

export function toBoardRow(meta: (typeof COMMODITIES)[number], row: SignalRow | undefined): BoardRow {
  const base = {
    symbol: meta.symbol,
    label: meta.label,
    category: meta.category,
  };
  if (!row) {
    return {
      ...base,
      signalId: null,
      direction: null,
      directionTie: false,
      grade: null,
      stance: null,
      entry: null,
      stopLoss: null,
      takeProfit: null,
      riskReward: null,
      confidence: null,
      addOns: [],
      summary: null,
      waitFor: null,
      reference: null,
      generatedAt: null,
      gapCount: 0,
    };
  }

  const plan = row.trade_plan;
  return {
    ...base,
    signalId: row.id,
    direction: row.direction,
    directionTie: row.direction_tie === true,
    grade: row.grade,
    stance: plan?.stance ?? null,
    entry: plan?.entry ?? null,
    stopLoss: plan?.stop_loss ?? null,
    takeProfit: plan?.take_profit ?? null,
    riskReward: plan?.risk_reward ?? null,
    confidence: row.confidence?.score ?? null,
    addOns: (plan?.add_ons ?? []).map((a: AddOnLevel) => ({
      sequence: a.sequence,
      price: a.price,
      structure: a.structure,
      new_stop_loss: a.new_stop_loss,
    })),
    summary: plan?.summary ?? null,
    waitFor: plan?.wait_for ?? null,
    reference: toReference(row),
    generatedAt: row.generated_at,
    gapCount: Array.isArray(row.data_gaps) ? row.data_gaps.length : 0,
  };
}

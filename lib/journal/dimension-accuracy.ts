import type { BiasDimension, BiasItem } from "@/types/signal";
import type { JournalEntry } from "@/types/journal";
import { BIAS_DIMENSIONS, computeDimensionScores } from "@/lib/dimension-scores";
import { AUTO_MARKER, PAPER_MARKER } from "./markers";

/**
 * 面向準確率 — which of the six dimensions actually predict anything here.
 *
 * The score weights 技術面, 基本面, 籌碼面, 新聞面, 資金流 and AI綜合 by hand,
 * and the hand never learns. The journal can: every auto-written row now
 * carries which dimensions agreed with the trade's direction, disagreed, or
 * sat out (a marker in the note, like the author markers), and this module
 * reads them back into a per-dimension record — when this dimension agreed,
 * what did the trade pay; when it disagreed, what did it pay. A dimension
 * whose agreement pays no better than its disagreement, over a real sample,
 * has no predictive value on this book and its weight is halved in the
 * score. Halved, never raised: "it was right before" is not evidence about
 * this trade, and a weight that can only fall cannot overfit upward.
 *
 * Real auto-tracked rows only, book-wide: predictive value is a property of
 * the dimension's method, not of one symbol.
 */

export const DIMENSION_MARKER = "[面向";
/** Rows where the dimension agreed, before its record may halve its weight. */
export const DIMENSION_MIN_TRADES = 12;

const SHORT: Record<BiasDimension, string> = {
  技術面: "技術",
  基本面: "基本",
  籌碼面: "籌碼",
  新聞面: "新聞",
  資金流: "資金",
  AI綜合: "AI",
};
const LONG = Object.fromEntries(Object.entries(SHORT).map(([k, v]) => [v, k])) as Record<string, BiasDimension>;

/** `[面向 技術:+ 基本:- 籌碼:0 新聞:+ 資金:0 AI:+]` — each dimension's stance on the trade's direction. */
export function dimensionMarker(direction: "long" | "short", items: BiasItem[]): string {
  const scores = computeDimensionScores(direction, items);
  const parts = BIAS_DIMENSIONS.map((d) => `${SHORT[d]}:${scores[d] > 0 ? "+" : scores[d] < 0 ? "-" : "0"}`);
  return `${DIMENSION_MARKER} ${parts.join(" ")}]`;
}

export type Stance = 1 | -1 | 0;

export function parseDimensions(entry: JournalEntry): Partial<Record<BiasDimension, Stance>> {
  const m = (entry.review_note ?? "").match(/\[面向([^\]]*)\]/);
  const out: Partial<Record<BiasDimension, Stance>> = {};
  if (!m) return out;
  for (const tok of m[1].trim().split(/\s+/)) {
    const [k, v] = tok.split(":");
    const dim = LONG[k];
    if (!dim) continue;
    out[dim] = v === "+" ? 1 : v === "-" ? -1 : 0;
  }
  return out;
}

export interface StanceRecord {
  trades: number;
  wins: number;
  losses: number;
  hitRate: number | null;
  expectancyPct: number | null;
}

export interface DimensionRecord {
  dimension: BiasDimension;
  agree: StanceRecord;
  oppose: StanceRecord;
  neutral: number;
  /** agree.expectancy − oppose.expectancy, when both are measured. */
  edgePct: number | null;
  /** 1 = full weight; 0.5 = halved for lack of predictive value. */
  scale: 1 | 0.5;
  note: string | null;
}

function isRealAuto(e: JournalEntry): boolean {
  const n = e.review_note ?? "";
  return n.includes(AUTO_MARKER) && !n.includes(PAPER_MARKER);
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function record(rows: JournalEntry[]): StanceRecord {
  const wins = rows.filter((e) => e.result === "win").length;
  const losses = rows.filter((e) => e.result === "loss").length;
  const resolved = wins + losses;
  return {
    trades: rows.length,
    wins,
    losses,
    hitRate: resolved > 0 ? r2((wins / resolved) * 100) : null,
    expectancyPct: rows.length > 0 ? r2(rows.reduce((s, e) => s + e.pnl_pct, 0) / rows.length) : null,
  };
}

/** Every dimension's record on the book's real trades. Dimensions with no marked rows are omitted. */
export function dimensionAccuracy(history: JournalEntry[]): DimensionRecord[] {
  const real = history.filter(isRealAuto).map((e) => ({ e, s: parseDimensions(e) }));
  const out: DimensionRecord[] = [];
  for (const dim of BIAS_DIMENSIONS) {
    const marked = real.filter(({ s }) => s[dim] !== undefined);
    if (marked.length === 0) continue;
    const agree = record(marked.filter(({ s }) => s[dim] === 1).map(({ e }) => e));
    const oppose = record(marked.filter(({ s }) => s[dim] === -1).map(({ e }) => e));
    const neutral = marked.filter(({ s }) => s[dim] === 0).length;
    const edgePct =
      agree.expectancyPct !== null && oppose.expectancyPct !== null ? r2(agree.expectancyPct - oppose.expectancyPct) : null;
    // No predictive value: agreement over a real sample pays nothing, or
    // pays no better than disagreement over a real sample of that too.
    const enough = agree.trades >= DIMENSION_MIN_TRADES;
    const noValue =
      enough &&
      ((agree.expectancyPct !== null && agree.expectancyPct <= 0) ||
        (oppose.trades >= DIMENSION_MIN_TRADES && edgePct !== null && edgePct <= 0));
    out.push({
      dimension: dim,
      agree,
      oppose,
      neutral,
      edgePct,
      scale: noValue ? 0.5 : 1,
      note: noValue
        ? `面向學習：${dim}同向時 ${agree.trades} 筆期望值 ${agree.expectancyPct}%/筆` +
          (oppose.trades >= DIMENSION_MIN_TRADES ? `，反向時 ${oppose.expectancyPct}%/筆` : "") +
          `，在這本帳上沒有預測力，本次權重減半`
        : null,
    });
  }
  return out;
}

export interface DimensionLearning {
  /** Dimensions whose weight was halved this time. */
  scaled: BiasDimension[];
  notes: string[];
}

/**
 * Applies the learned scales: a halved dimension's items drop one weight
 * step (2 → 1, 1 → 0). Returns new items; the originals are untouched.
 */
export function applyDimensionScales(
  items: BiasItem[],
  records: DimensionRecord[],
): { items: BiasItem[]; learning: DimensionLearning } {
  const halved = new Set(records.filter((r) => r.scale < 1).map((r) => r.dimension));
  if (halved.size === 0) return { items, learning: { scaled: [], notes: [] } };
  const next = items.map((it) =>
    halved.has(it.dimension) && it.weight > 0
      ? { ...it, weight: (it.weight - 1) as 0 | 1 | 2, factor: `${it.factor}（面向學習：權重減半）` }
      : it,
  );
  return {
    items: next,
    learning: {
      scaled: [...halved],
      notes: records.filter((r) => r.note).map((r) => r.note as string),
    },
  };
}

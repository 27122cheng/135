import type { JournalEntry } from "@/types/journal";
import { AUTO_MARKER, PAPER_MARKER } from "./markers";

/**
 * 情境實績 — what the system's own trades say about the situations it is
 * actually good at, and a veto for the ones it is measurably not.
 *
 * Every gate in this system asks whether a *setup* is good. None asked the
 * question a desk asks after a hundred trades: in which conditions does this
 * system make money, and in which does it reliably lose? Grade alone cannot
 * answer it — an A in a ranging market and an A in a trend are different
 * bets — and the journal already holds the answer, unread.
 *
 * So each auto-written row now carries the context it was taken in (a
 * marker in the note, like the author markers): the confidence band, the
 * regime the thesis named, the session, the grade. This module reads those
 * back into buckets with a realised expectancy each, and:
 *
 *  - puts one line on the card and in the push — 「信心 60–74：+0.4%/筆
 *    （18 筆）」 — so the reader knows in one glance whether trades like
 *    this one have paid;
 *  - vetoes a new entry whose bucket has lost money over a real sample.
 *    Only vetoes: a good bucket adds nothing, because "we did well here
 *    before" is not evidence about this trade.
 *
 * Real auto-tracked rows only. Book-wide, not per symbol: the situation is
 * the unit, and twelve trades per symbol per bucket is a year away.
 */

export const CONTEXT_MARKER = "[情境";
/** A bucket needs this many resolved real trades before it may veto. */
export const CONTEXT_MIN_TRADES = 12;

export type ConfidenceBand = "<45" | "45-59" | "60-74" | "75+";
export type Regime = "trending" | "ranging" | "transitional" | "unknown";
export type Session = "主時段" | "非主時段";

export interface TradeContext {
  confidenceBand: ConfidenceBand | null;
  regime: Regime | null;
  session: Session | null;
  grade: string | null;
}

export function confidenceBand(score: number | null | undefined): ConfidenceBand | null {
  if (score == null || !Number.isFinite(score)) return null;
  if (score < 45) return "<45";
  if (score < 60) return "45-59";
  if (score < 75) return "60-74";
  return "75+";
}

/** The marker auto-log appends to the note, e.g. `[情境 信心:62 行情:trending 時段:主]`. */
export function contextMarker(ctx: {
  confidenceScore: number | null | undefined;
  regime: string | null | undefined;
  mainSession: boolean;
}): string {
  const parts = [
    ctx.confidenceScore != null && Number.isFinite(ctx.confidenceScore) ? `信心:${Math.round(ctx.confidenceScore)}` : null,
    `行情:${ctx.regime ?? "unknown"}`,
    `時段:${ctx.mainSession ? "主" : "非主"}`,
  ].filter((p): p is string => p !== null);
  return `${CONTEXT_MARKER} ${parts.join(" ")}]`;
}

export function parseContext(entry: JournalEntry): TradeContext {
  const note = entry.review_note ?? "";
  const m = note.match(/\[情境([^\]]*)\]/);
  const fields = new Map<string, string>();
  if (m) {
    for (const tok of m[1].trim().split(/\s+/)) {
      const [k, v] = tok.split(":");
      if (k && v) fields.set(k, v);
    }
  }
  const score = fields.has("信心") ? Number(fields.get("信心")) : null;
  const regimeRaw = fields.get("行情") ?? null;
  const regime: Regime | null =
    regimeRaw === "trending" || regimeRaw === "ranging" || regimeRaw === "transitional"
      ? regimeRaw
      : regimeRaw
        ? "unknown"
        : null;
  const sessionRaw = fields.get("時段") ?? null;
  return {
    confidenceBand: confidenceBand(score),
    regime,
    session: sessionRaw === "主" ? "主時段" : sessionRaw === "非主" ? "非主時段" : null,
    grade: entry.grade ?? null,
  };
}

export type ContextDimension = "confidence" | "regime" | "session" | "grade";

export interface ContextBucket {
  dimension: ContextDimension;
  key: string;
  label: string;
  trades: number;
  wins: number;
  losses: number;
  hitRate: number | null;
  /** Mean pnl_pct per trade, breakeven rows included. */
  expectancyPct: number;
}

const DIM_LABEL: Record<ContextDimension, string> = {
  confidence: "信心",
  regime: "行情",
  session: "時段",
  grade: "評等",
};
const REGIME_LABEL: Record<Regime, string> = {
  trending: "趨勢",
  ranging: "盤整",
  transitional: "過渡",
  unknown: "未知",
};

function isRealAuto(e: JournalEntry): boolean {
  const n = e.review_note ?? "";
  return n.includes(AUTO_MARKER) && !n.includes(PAPER_MARKER);
}

function keyOf(dim: ContextDimension, ctx: TradeContext): string | null {
  switch (dim) {
    case "confidence":
      return ctx.confidenceBand;
    case "regime":
      return ctx.regime;
    case "session":
      return ctx.session;
    case "grade":
      return ctx.grade;
  }
}

function labelOf(dim: ContextDimension, key: string): string {
  if (dim === "regime") return `${DIM_LABEL[dim]} ${REGIME_LABEL[key as Regime] ?? key}`;
  if (dim === "confidence") return `${DIM_LABEL[dim]} ${key.replace("-", "–")}`;
  return `${DIM_LABEL[dim]} ${key}`;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Every observed bucket, real rows only, biggest samples first within a dimension. */
export function contextBuckets(history: JournalEntry[]): ContextBucket[] {
  const real = history.filter(isRealAuto);
  const by = new Map<string, { dim: ContextDimension; key: string; rows: JournalEntry[] }>();
  for (const e of real) {
    const ctx = parseContext(e);
    for (const dim of ["confidence", "regime", "session", "grade"] as ContextDimension[]) {
      const key = keyOf(dim, ctx);
      if (!key) continue;
      const id = `${dim}:${key}`;
      const slot = by.get(id) ?? { dim, key, rows: [] };
      slot.rows.push(e);
      by.set(id, slot);
    }
  }
  return [...by.values()]
    .map(({ dim, key, rows }) => {
      const wins = rows.filter((e) => e.result === "win").length;
      const losses = rows.filter((e) => e.result === "loss").length;
      const resolved = wins + losses;
      return {
        dimension: dim,
        key,
        label: labelOf(dim, key),
        trades: rows.length,
        wins,
        losses,
        hitRate: resolved > 0 ? r2((wins / resolved) * 100) : null,
        expectancyPct: r2(rows.reduce((s, e) => s + e.pnl_pct, 0) / rows.length),
      };
    })
    .sort((a, b) => a.dimension.localeCompare(b.dimension) || b.trades - a.trades);
}

export interface ContextRecord {
  /** One line per dimension the signal falls into, biggest samples first. */
  lines: string[];
  veto: boolean;
  reason: string | null;
}

/**
 * The record for THIS signal's situation, and whether it forbids the entry.
 * A bucket vetoes when it has CONTEXT_MIN_TRADES real trades and a negative
 * realised expectancy; nothing here ever adds to a signal.
 */
export function contextVerdict(
  history: JournalEntry[],
  ctx: TradeContext,
): ContextRecord {
  const buckets = contextBuckets(history);
  const mine = (["confidence", "regime", "session", "grade"] as ContextDimension[])
    .map((dim) => {
      const key = keyOf(dim, ctx);
      return key ? buckets.find((b) => b.dimension === dim && b.key === key) ?? null : null;
    })
    .filter((b): b is ContextBucket => b !== null)
    .sort((a, b) => b.trades - a.trades);
  const lines = mine.map(
    (b) =>
      `${b.label}：${b.expectancyPct > 0 ? "+" : ""}${b.expectancyPct}%/筆（${b.trades} 筆` +
      `${b.hitRate !== null ? `，勝率 ${b.hitRate}%` : ""}）`,
  );
  const bad = mine.find((b) => b.trades >= CONTEXT_MIN_TRADES && b.expectancyPct < 0);
  return {
    lines,
    veto: bad !== undefined,
    reason: bad
      ? `情境實績為負：${bad.label} 過去 ${bad.trades} 筆真實交易期望值 ${bad.expectancyPct}%/筆` +
        `${bad.hitRate !== null ? `（勝率 ${bad.hitRate}%）` : ""}，這種情境下系統實測在賠錢`
      : null,
  };
}

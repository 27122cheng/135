/**
 * Stage 3 data contracts — 停損復盤與干涉機制.
 * Field names mirror the spec exactly — do not rename.
 */

/** 停損原因分類. The tag is chosen by the human reviewing the trade, never by AI. */
export type StopReasonTag = "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7" | "S8";

export const STOP_REASON_LABELS: Record<StopReasonTag, string> = {
  S1: "結構誤判（方向根本錯）",
  S2: "進場位置太差（追價、未等回測）",
  S3: "停損過窄被掃（結構抓對但 buffer 不足）",
  S4: "事件衝擊（數據或突發新聞）",
  S5: "執行問題（滑價、點差、時段流動性差）",
  S6: "未依規則進場（紀律問題）",
  S7: "總經方向反向（基本面判斷錯）",
  S8: "籌碼反向（COT / 未平倉量訊號被忽略）",
};

export const STOP_REASON_TAGS = Object.keys(STOP_REASON_LABELS) as StopReasonTag[];

/**
 * 可事前預防 — the first term of the severity formula.
 *
 * The spec gives the formula but not which tags count as preventable, so it is
 * pinned here as a constant rather than judged per-entry. Two reasons: severity
 * has to be reproducible from (tag, pnl, history) alone, and the intervention
 * rules average severity *per tag* — if the same tag could score differently
 * on a reviewer's mood, that average would measure the reviewer, not the mistake.
 *
 * The split is "could a rule have stopped this before entry?":
 *  - preventable: entry quality (S2), stop sizing (S3), execution conditions
 *    (S5), discipline (S6), and ignoring a positioning signal we already had (S8)
 *  - not preventable: reading the structure wrong (S1), a shock that hadn't
 *    happened yet (S4), and a macro call that was defensible but wrong (S7)
 *
 * Change this table if you disagree — it is the one judgement call in an
 * otherwise mechanical formula.
 */
export const PREVENTABLE_TAGS: Record<StopReasonTag, boolean> = {
  S1: false,
  S2: true,
  S3: true,
  S4: false,
  S5: true,
  S6: true,
  S7: false,
  S8: true,
};

export type TradeResult = "win" | "loss" | "breakeven";

/** A row of `trade_journal` — one closed trade, reviewed. */
export interface JournalEntry {
  id: string;
  /** The `signals` row this trade came from; null for a manually logged trade. */
  signal_id: string | null;
  symbol: string;
  direction: "long" | "short";
  grade: string;
  entry_price: number;
  exit_price: number;
  result: TradeResult;
  /** Signed: negative for a loss. */
  pnl_pct: number;
  closed_at: string;
  /** Only meaningful on a loss; null on wins. */
  stop_reason_tag: StopReasonTag | null;
  /** Computed by lib/journal/severity.ts — never entered by hand, never by AI. */
  severity: number | null;
  review_note: string | null;
  created_at: string;
}

/** What the caller supplies; severity is derived, not accepted from input. */
export interface JournalEntryInput {
  signal_id: string | null;
  symbol: string;
  direction: "long" | "short";
  grade: string;
  entry_price: number;
  exit_price: number;
  result: TradeResult;
  pnl_pct: number;
  closed_at: string;
  stop_reason_tag: StopReasonTag | null;
  review_note: string | null;
}

/** Per-tag history used to decide interventions. */
export interface TagStat {
  tag: StopReasonTag;
  count: number;
  avgSeverity: number;
  /** Summed pnl_pct across those entries (negative). */
  cumulativeLossPct: number;
}

/**
 * One intervention actually applied to a signal. Every field exists so the
 * card can say *what* was tightened and *which* past stops justified it —
 * the spec requires the reason to be visible, not just the effect.
 */
export interface AppliedIntervention {
  /** null on the net-effect summary line, which no single tag owns. */
  tag: StopReasonTag | null;
  /** What changed, in one line of 繁體中文. */
  effect: string;
  /** e.g. "近 30 筆中 S3 出現 4 次，平均 severity 3.5" */
  evidence: string;
  /** closed_at of the entries that triggered it, newest first. */
  triggered_by: string[];
}

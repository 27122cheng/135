import type { SignalStore } from "@/lib/db";
import type { SignalRow } from "@/types/signal";
import type { JournalEntry, TradeResult } from "@/types/journal";
import { computeSeverity } from "./severity";
import { describeConsequence, reviewStop, type StopContext } from "./stop-review";
import { fetchOHLCV } from "@/lib/data-sources/ohlcv";
import type { CommodityMeta } from "@/types/signal";

/**
 * Writes the journal entry when a tracked plan resolves, so the intervention
 * engine has something to learn from.
 *
 * ## Why anything is written automatically
 *
 * `computeInterventions` reads `trade_journal`, and until now that table only
 * ever filled up if someone sat down and wrote a post-mortem for each stop-out.
 * Nobody does that, so every signal was built with the default effects — the
 * whole Stage 3 feedback loop was wired up and switched off.
 *
 * ## The marker, and why it is in the note
 *
 * Auto-written entries are prefixed `[自動追蹤]`. That is a convention rather
 * than a column because adding a column to a live table needs a migration path
 * this deployment does not currently have, and the marker has to be visible to
 * the reader anyway: an entry the system wrote about a position nobody actually
 * held is a different kind of evidence from one a human reviewed, and the
 * review page must not present them as the same thing.
 *
 * Paper entries assume the fill happened exactly at the level with no slippage
 * and no spread. That is why S5 (執行問題) can never be diagnosed from them and
 * why their win rate reads optimistically — both stated on the entry itself.
 */

/** Prefix on every auto-written review note. Also how the UI recognises them. */
export const AUTO_MARKER = "[自動追蹤]";
/** Additional marker for a plan nobody was ever told to take. */
export const PAPER_MARKER = "[參考價位紙上追蹤]";

export interface ResolveInput {
  store: SignalStore;
  meta: CommodityMeta;
  signal: SignalRow;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  exitPrice: number;
  outcome: "stop_hit" | "target_hit";
  /** True when these levels were 參考價位 rather than a recommended trade. */
  paper: boolean;
  /** A high-impact release landed while the position was open. */
  eventDuringHold: boolean;
  gaps: string[];
}

/**
 * Best price seen in the trade's favour, from the candles rather than from
 * stored state.
 *
 * The monitor samples every five minutes and keeps no history, so tracking the
 * excursion in its memory would both need a schema change and be a worse
 * measurement than the bars already record. Only fetched when a trade actually
 * resolves, which is rare enough that the request cost does not matter.
 */
async function bestPriceSince(
  meta: CommodityMeta,
  direction: "long" | "short",
  since: string,
  gaps: string[],
): Promise<number | null> {
  const bars = await fetchOHLCV(meta, "H4", gaps).catch(() => null);
  if (!bars?.candles?.length) return null;
  const start = new Date(since).getTime();
  const after = bars.candles.filter((c) => new Date(c.time).getTime() >= start);
  if (after.length === 0) return null;
  return direction === "long"
    ? Math.max(...after.map((c) => c.high))
    : Math.min(...after.map((c) => c.low));
}

export interface AutoLogResult {
  entry: JournalEntry | null;
  tag: string | null;
  decidedBy: "ai" | "rules" | null;
  note: string;
}

export async function recordResolvedPlan(input: ResolveInput): Promise<AutoLogResult> {
  const { store, signal, entry, stopLoss, takeProfit, exitPrice, outcome, paper } = input;

  const risk = Math.abs(entry - stopLoss);
  const move = signal.direction === "long" ? exitPrice - entry : entry - exitPrice;
  const pnlPct = entry > 0 ? Math.round((move / entry) * 10000) / 100 : 0;
  const result: TradeResult = outcome === "target_hit" ? "win" : "loss";

  const markers = paper ? `${AUTO_MARKER}${PAPER_MARKER}` : AUTO_MARKER;

  if (result === "win") {
    // Wins are logged without a review: `stop_reason_tag` is only meaningful on
    // a loss, and severity is defined over losses. The row still matters — the
    // severity formula measures a loss against the average of prior ones, so a
    // journal made only of losses would make every loss look ordinary.
    try {
      const written = await store.insertJournalEntry(
        {
          signal_id: signal.id,
          symbol: signal.symbol,
          direction: signal.direction,
          grade: signal.grade,
          entry_price: entry,
          exit_price: exitPrice,
          result,
          pnl_pct: pnlPct,
          closed_at: new Date().toISOString(),
          stop_reason_tag: null,
          review_note:
            `${markers} 觸及停利 ${takeProfit}，未經人工複核。` +
            (paper ? "此為參考價位的紙上追蹤，假設在價位上成交、無滑價與點差。" : ""),
        },
        null,
      );
      return { entry: written, tag: null, decidedBy: null, note: "停利，已記錄" };
    } catch (err) {
      return {
        entry: null,
        tag: null,
        decidedBy: null,
        note: `寫入交易日誌失敗：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const bestPrice = await bestPriceSince(
    input.meta,
    signal.direction,
    signal.generated_at,
    input.gaps,
  );

  const ctx: StopContext = {
    signal,
    entry,
    stopLoss,
    takeProfit,
    exitPrice,
    bestPrice,
    eventDuringHold: input.eventDuringHold,
  };
  const review = await reviewStop(ctx, input.gaps);

  // Severity is measured against this symbol's own prior losses, exactly as the
  // manual path does — same formula, same history, so an auto entry and a hand
  // entry are comparable.
  const history = await store.listJournal({ symbol: signal.symbol, limit: 30 }).catch(() => []);
  const severity = computeSeverity({
    tag: review.tag,
    pnlPct,
    history,
  }).severity;

  try {
    const written = await store.insertJournalEntry(
      {
        signal_id: signal.id,
        symbol: signal.symbol,
        direction: signal.direction,
        grade: signal.grade,
        entry_price: entry,
        exit_price: exitPrice,
        result,
        pnl_pct: pnlPct,
        closed_at: new Date().toISOString(),
        stop_reason_tag: review.tag,
        review_note:
          `${markers} 觸及停損 ${stopLoss}（最大順向 ${
            bestPrice === null || !(risk > 0)
              ? "未知"
              : `${Math.round(((signal.direction === "long" ? bestPrice - entry : entry - bestPrice) / risk) * 100) / 100}R`
          }）。` +
          `分類 ${review.tag}（由${review.decidedBy === "ai" ? " AI 複核" : "規則判定"}）：${review.note} ` +
          describeConsequence(review.tag) +
          (paper
            ? " 此為參考價位的紙上追蹤，假設在價位上成交、無滑價與點差，因此不會診斷為執行問題。"
            : ""),
      },
      severity,
    );
    return {
      entry: written,
      tag: review.tag,
      decidedBy: review.decidedBy,
      note: `停損，已分類為 ${review.tag}，severity ${severity}`,
    };
  } catch (err) {
    return {
      entry: null,
      tag: review.tag,
      decidedBy: review.decidedBy,
      note: `已分類為 ${review.tag}，但寫入交易日誌失敗：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

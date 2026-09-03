import type { SignalStore } from "@/lib/db";
import type { SignalRow } from "@/types/signal";
import { STOP_REASON_LABELS, type JournalEntry, type StopReasonTag, type TradeResult } from "@/types/journal";
import { computeSeverity } from "./severity";
import { describeConsequence, reviewStop, type StopContext } from "./stop-review";
import { fetchOHLCV } from "@/lib/data-sources/ohlcv";
import { classifyR } from "@/lib/analysis/lab-manage";
import { AUTO_MARKER, PAPER_MARKER } from "./markers";
import { usableJournal } from "./quarantine";
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

// Defined in ./markers (a leaf both this module and the quarantine gate can
// import); re-exported here so every existing import path keeps working.
export { AUTO_MARKER, PAPER_MARKER };

export interface ResolveInput {
  store: SignalStore;
  meta: CommodityMeta;
  signal: SignalRow;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  exitPrice: number;
  outcome: "stop_hit" | "target_hit" | "structure_exit" | "thesis_exit";
  /**
   * 分批止盈 — the price at which half the position was banked before the
   * final exit, or null when the trade never touched its target. When set,
   * the P&L is blended: half the position at this price, half at exitPrice —
   * the same arithmetic the exit engine's backtest uses (SCALE_OUT_FRACTION),
   * so the journal and the lab describe the same trade.
   */
  scaleOutPrice?: number | null;
  /** True when these levels were 參考價位 rather than a recommended trade. */
  paper: boolean;
  /** A high-impact release landed while the position was open. */
  eventDuringHold: boolean;
  gaps: string[];
}

/**
 * The `signal_id` a journal row may carry.
 *
 * `trade_journal.signal_id` is a uuid column with a foreign key into `signals`.
 * The row the monitor resolves against comes from `latest_signal`, whose id is
 * the SYMBOL, not a uuid (`latestPerSymbol` says so) — so every auto-written
 * resolution on that path was rejected by the database with
 * "invalid input syntax for type uuid" and swallowed into a note nobody reads.
 * The `plan_monitor` write beside it already guards for exactly this; the
 * journal write did not. Same rule here: a uuid is kept, anything else is
 * null, which is what the column means by "not from a stored signal row".
 */
export function journalSignalId(id: string | null | undefined): string | null {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
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

/**
 * 系統自己的結論 —— what the classification concluded, in pieces a push can
 * render.
 *
 * All of this was already being computed and written to the journal, and none
 * of it ever reached the person: the stop-hit push told them 「請到 /review
 * 記錄並選一個 S1–S8 停損原因」 — asking them to do, by hand, work the system
 * had just finished doing, and never showing the answer. A feedback loop
 * nobody is told the output of teaches nobody anything.
 */
export interface ResolutionOutcome {
  result: TradeResult;
  pnlPct: number;
  /** Set only on a real loss — S1–S8 classifies stop-outs, not wins. */
  tag: StopReasonTag | null;
  label: string | null;
  decidedBy: "ai" | "rules" | null;
  /** The reasoning written at classification time. */
  why: string | null;
  /** What accumulating this tag tightens on future signals. */
  consequence: string | null;
  severity: number | null;
  /** One line naming the kind of exit, for the headline. */
  kind: string;
}

export interface AutoLogResult {
  entry: JournalEntry | null;
  tag: string | null;
  decidedBy: "ai" | "rules" | null;
  note: string;
  /** Null only when the write failed — the push then says nothing it cannot back. */
  outcome: ResolutionOutcome | null;
}

/**
 * 同一筆交易不寫第二次 —— the write-side half of the duplicate invariant.
 *
 * The read-side gate (lib/journal/quarantine.ts) stops a repeat from reaching
 * a statistic; this stops it being written at all, so the table itself stays
 * honest and the operator does not open /review to ten copies of one trade.
 * Both are needed: the reader protects the numbers, the writer protects the
 * record, and only the writer can say "nothing happened" instead of logging
 * a resolution that already happened.
 *
 * Same identity the deduper uses — signal, direction, and the two prices the
 * trade ran between. A store that cannot be read falls through to writing:
 * losing a real resolution is worse than tolerating a duplicate the reader
 * will collapse anyway.
 */
async function alreadyLogged(
  store: SignalStore,
  signal: SignalRow,
  entry: number,
  exitPrice: number,
): Promise<boolean> {
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.abs(b) * 1e-9;
  try {
    const recent = await store.listJournal({ symbol: signal.symbol, limit: 30 });
    return recent.some(
      (e) =>
        (journalSignalId(e.signal_id) ?? "") === (journalSignalId(signal.id) ?? "") &&
        e.direction === signal.direction &&
        near(e.entry_price, entry) &&
        near(e.exit_price, exitPrice),
    );
  } catch {
    return false;
  }
}

export async function recordResolvedPlan(input: ResolveInput): Promise<AutoLogResult> {
  const { store, signal, entry, stopLoss, takeProfit, exitPrice, outcome, paper } = input;

  if (await alreadyLogged(store, signal, entry, exitPrice)) {
    return {
      entry: null,
      tag: null,
      decidedBy: null,
      note: "這筆交易的結算已經記錄過，不重複寫入",
      // Nothing new was concluded, so nothing is pushed: a second "本次交易
      // 結束" for a trade that ended hours ago is noise that reads as a new
      // loss.
      outcome: null,
    };
  }

  const risk = Math.abs(entry - stopLoss);
  const scaled = input.scaleOutPrice ?? null;
  const dirMove = (px: number) => (signal.direction === "long" ? px - entry : entry - px);
  // Blended when half was banked at the target first — half the position's
  // move comes from the scale-out price, half from the final exit.
  const move = scaled !== null ? 0.5 * dirMove(scaled) + 0.5 * dirMove(exitPrice) : dirMove(exitPrice);
  const pnlPct = entry > 0 ? Math.round((move / entry) * 10000) / 100 : 0;
  // Scratch-aware, like the backtest that approved the plan: the breakeven
  // and trailing rules *manufacture* near-zero exits, and booking a stop-out
  // at the entry as a "loss" both poisons the realized win rate and hands
  // the S1–S8 review a trade that was never a real loss. |move| within
  // SCRATCH_R of the original risk is a breakeven wash — the journal's own
  // vocabulary already has the word.
  const moveR = risk > 0 ? move / risk : 0;
  const result: TradeResult =
    classifyR(moveR) === "scratch" ? "breakeven" : moveR > 0 ? "win" : "loss";

  const markers = paper ? `${AUTO_MARKER}${PAPER_MARKER}` : AUTO_MARKER;

  /** The outcome every non-loss path reports — no S-tag, because S1–S8 classifies stop-outs. */
  const plainOutcome = (kind: string): ResolutionOutcome => ({
    result,
    pnlPct,
    tag: null,
    label: null,
    decidedBy: null,
    why: null,
    consequence: null,
    severity: null,
    kind,
  });

  if (scaled !== null && outcome !== "target_hit") {
    // 分批止盈後的收尾 — not a stop-out to classify. The S1–S8 taxonomy
    // diagnoses trades the market took out at the original risk; a trade
    // that banked half at its target and then had the remainder trailed or
    // scratched is the management rules *working*, and feeding it to the
    // intervention engine as a loss-to-fix would teach exactly the wrong
    // lesson. It still counts toward the realized-rate audit.
    try {
      const written = await store.insertJournalEntry(
        {
          signal_id: journalSignalId(signal.id),
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
            `${markers} 分批止盈：先在 ${scaled} 平一半落袋，剩餘半倉` +
            (outcome === "stop_hit"
              ? `於停損 ${exitPrice} 出場`
              : `因結構翻轉以市價 ${exitPrice} 出場`) +
            `（兩半各計一半，合計${result === "win" ? "獲利" : result === "breakeven" ? "打平" : "虧損"} ${pnlPct}%）。` +
            (paper ? "此為參考價位的紙上追蹤，假設在價位上成交、無滑價與點差。" : ""),
        },
        null,
      );
      return { entry: written, tag: null, decidedBy: null, note: "分批止盈後收尾，已記錄", outcome: plainOutcome("分批止盈後收尾") };
    } catch (err) {
      return {
        entry: null,
        tag: null,
        decidedBy: null,
        note: `寫入交易日誌失敗：${err instanceof Error ? err.message : String(err)}`,
        outcome: null,
      };
    }
  }

  if (outcome === "structure_exit" || outcome === "thesis_exit") {
    const thesis = outcome === "thesis_exit";
    // Not a stop-out: the S1–S8 stop taxonomy classifies trades the market
    // took out at a level, and forcing a market exit into it would teach the
    // intervention engine the wrong lesson. Logged with the exit reason
    // instead — the win/loss still counts toward the realized-rate audit.
    try {
      const written = await store.insertJournalEntry(
        {
          signal_id: journalSignalId(signal.id),
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
            `${markers} ${thesis ? "論點失效出場" : "結構翻轉出場"} ${exitPrice}（${result === "win" ? "獲利" : result === "breakeven" ? "打平" : "虧損"} ${pnlPct}%），` +
            (thesis
              ? `未觸及停損停利：計畫所需的行情性質已結束（ER(20) 越過門檻），進場前提失效，依計畫卡上的失效條件以市價出場。`
              : `未觸及停損停利：日線出現反向 CHoCH，進場理由失效，依管理規則以市價出場。`) +
            (paper ? "此為參考價位的紙上追蹤，假設在價位上成交、無滑價與點差。" : ""),
        },
        null,
      );
      return {
        entry: written, tag: null, decidedBy: null,
        note: thesis ? "論點失效出場，已記錄" : "結構翻轉出場，已記錄",
        outcome: plainOutcome(thesis ? "論點失效出場" : "結構翻轉出場"),
      };
    } catch (err) {
      return {
        entry: null,
        tag: null,
        decidedBy: null,
        note: `寫入交易日誌失敗：${err instanceof Error ? err.message : String(err)}`,
        outcome: null,
      };
    }
  }

  if (result === "win") {
    // Wins are logged without a review: `stop_reason_tag` is only meaningful on
    // a loss, and severity is defined over losses. The row still matters — the
    // severity formula measures a loss against the average of prior ones, so a
    // journal made only of losses would make every loss look ordinary.
    try {
      const written = await store.insertJournalEntry(
        {
          signal_id: journalSignalId(signal.id),
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
      return { entry: written, tag: null, decidedBy: null, note: "觸及停利，已記錄", outcome: plainOutcome("觸及停利") };
    } catch (err) {
      return {
        entry: null,
        tag: null,
        decidedBy: null,
        note: `寫入交易日誌失敗：${err instanceof Error ? err.message : String(err)}`,
        outcome: null,
      };
    }
  }

  if (result === "breakeven") {
    // 保本出場 — the stop was hit *at or near the entry* because the
    // breakeven/trailing rules had already moved it there. Not a loss: no
    // S-tag, no severity, and the intervention engine never sees it as one.
    // Still a row — the realized audit counts washes, and hiding them would
    // overstate how often the system actually decides.
    try {
      const written = await store.insertJournalEntry(
        {
          signal_id: journalSignalId(signal.id),
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
            `${markers} 保本出場 ${exitPrice}（${pnlPct}%）：停損已被保本／移停規則移到成本附近，` +
            `此為管理規則運作的打平，不列入停損原因分類。` +
            (paper ? "此為參考價位的紙上追蹤，假設在價位上成交、無滑價與點差。" : ""),
        },
        null,
      );
      return { entry: written, tag: null, decidedBy: null, note: "保本出場，已記錄", outcome: plainOutcome("保本出場") };
    } catch (err) {
      return {
        entry: null,
        tag: null,
        decidedBy: null,
        note: `寫入交易日誌失敗：${err instanceof Error ? err.message : String(err)}`,
        outcome: null,
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
  // Severity measures this loss against the symbol's prior ones; a baseline
  // of fabricated wins makes every real loss look extraordinary.
  const history = usableJournal(
    await store.listJournal({ symbol: signal.symbol, limit: 30 }).catch(() => []),
  );
  const severity = computeSeverity({
    tag: review.tag,
    pnlPct,
    history,
  }).severity;

  try {
    const written = await store.insertJournalEntry(
      {
        signal_id: journalSignalId(signal.id),
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
      // The whole point of the classification: it goes to the person, not
      // just into a table they were told to fill in themselves.
      outcome: {
        result,
        pnlPct,
        tag: review.tag,
        label: STOP_REASON_LABELS[review.tag],
        decidedBy: review.decidedBy,
        why: review.note,
        consequence: describeConsequence(review.tag),
        severity,
        kind: "觸及停損",
      },
    };
  } catch (err) {
    return {
      entry: null,
      tag: review.tag,
      decidedBy: review.decidedBy,
      note: `已分類為 ${review.tag}，但寫入交易日誌失敗：${err instanceof Error ? err.message : String(err)}`,
      // No stored row, no reported lesson: a push claiming the system learned
      // something it failed to persist would be the worst kind of false
      // reassurance — next sweep it would have learned nothing.
      outcome: null,
    };
  }
}

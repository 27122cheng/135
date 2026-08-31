import { AUTO_MARKER } from "./markers";
import type { JournalEntry } from "@/types/journal";

/**
 * 汙染隔離 —— journal rows the system fabricated, kept visible and kept out of
 * every statistic.
 *
 * ## What happened
 *
 * Until commit 36807d4 (2026-08-12, "Stop the fictional trade replays") the
 * monitor decided a fill with `reached()` — profit-side logic, correct for
 * targets and add-ons and completely wrong for an entry. The plans' entries
 * are pullback limit orders: a long fills when price comes *down* to it. With
 * `reached()`, a long "filled" the instant price was anywhere ABOVE the entry,
 * so any stale plan whose levels sat below a risen market booked its entry and
 * its take-profit in the same tick — a winning trade that never existed,
 * pushed to Telegram and written here as a 停利.
 *
 * The fill rule was fixed that day. Nothing cleaned up after it, and the
 * fabrications stayed in the table doing damage the whole time:
 *
 *  - /review reported a **100% win rate at every grade** — 500 rows, 500
 *    wins, not one loss. Impossible, and the operator said so.
 *  - 停損原因分布 and severity 趨勢 were permanently empty: the taxonomy
 *    classifies stop-outs, and a table with no losses in it has none to
 *    classify. The learning loop had nothing to learn from.
 *  - 實績校準 compares realized results against what the floors promised and
 *    *raises* the veto line when reality lags. Fed a 100% win rate, it
 *    concluded the system was beating its own promises and never tightened
 *    anything.
 *  - The same trade appeared ten times over, because every rescan re-armed
 *    the same fictional fill — 「下方學習都是同一筆的訂單」.
 *
 * ## Why quarantine rather than delete
 *
 * Deleting a user's rows to make a number look better is the one thing a
 * system that reports its own track record must never do, and a DELETE run
 * from here could not be reviewed before it destroyed the evidence. These
 * stay in the table and stay on the page, labelled and counted, excluded from
 * every statistic. If the diagnosis below is ever shown to be wrong the rows
 * are still there to re-admit.
 *
 * ## The boundary, and why it is this one
 *
 * Auto-written (`AUTO_MARKER`) **and** closed on or before the day the fill
 * rule was fixed. Both halves are needed and neither is arbitrary:
 *
 *  - a hand-written entry from that period describes a trade a person
 *    actually watched, and no bug in the monitor could fabricate it;
 *  - after the fix a long can no longer fill above its entry, so a row from
 *    2026-08-13 onward was produced by fill logic that cannot invent a trade.
 */
export const FABRICATION_FIXED_AT = "2026-08-13T00:00:00.000Z";

/** The commit that fixed the fill rule, for the page to cite. */
export const FABRICATION_FIX_COMMIT = "36807d4";

export function isFabricated(entry: JournalEntry): boolean {
  if (!entry.review_note?.includes(AUTO_MARKER)) return false;
  const closed = entry.closed_at;
  // An unparseable timestamp is not evidence of fabrication — leave it in and
  // let the row speak for itself rather than quietly discarding data.
  if (!closed) return false;
  return closed < FABRICATION_FIXED_AT;
}

/**
 * 同一筆交易只算一次 —— collapse rows describing the same resolution.
 *
 * A trade is identified by the signal it came from, its direction and the two
 * prices it ran between. Real trading cannot produce that tuple twice: a plan
 * resolves once and its monitor state goes terminal. A repeat means something
 * re-armed a finished trade — which is exactly what the fill bug did, and
 * exactly what the operator saw as ten identical XAUUSD rows.
 *
 * The earliest row wins, so the surviving copy is the one written when the
 * trade actually resolved. Kept as a separate pass from {@link isFabricated}
 * because it is a permanent invariant, not a cleanup: any future bug that
 * re-arms a resolved plan is neutralised here before it can reach a statistic.
 */
export function dedupeJournal(entries: JournalEntry[]): {
  unique: JournalEntry[];
  duplicates: JournalEntry[];
} {
  const key = (e: JournalEntry) =>
    [e.signal_id ?? "", e.symbol, e.direction, e.entry_price, e.exit_price, e.result].join("|");
  // Oldest first so the first sighting of a key is the original.
  const byAge = [...entries].sort((a, b) => a.closed_at.localeCompare(b.closed_at));
  const seen = new Set<string>();
  const unique: JournalEntry[] = [];
  const duplicates: JournalEntry[] = [];
  for (const e of byAge) {
    const k = key(e);
    if (seen.has(k)) duplicates.push(e);
    else {
      seen.add(k);
      unique.push(e);
    }
  }
  return { unique, duplicates };
}

export interface JournalPartition {
  /** Rows every statistic, audit and intervention may use. */
  usable: JournalEntry[];
  /** Fabricated by the pre-fix fill rule. Shown, never counted. */
  fabricated: JournalEntry[];
  /** Re-armed repeats of a resolution already counted. */
  duplicates: JournalEntry[];
}

/**
 * The one gate every journal reader goes through.
 *
 * Its own function rather than a filter at each call site because there are
 * six readers — the review page, the weekly digest, the intervention engine,
 * the severity baseline, the journal API and the track record — and a
 * contaminated row reaching any one of them is a lie in a different place.
 */
export function partitionJournal(entries: JournalEntry[]): JournalPartition {
  const fabricated: JournalEntry[] = [];
  const clean: JournalEntry[] = [];
  for (const e of entries) (isFabricated(e) ? fabricated : clean).push(e);
  const { unique, duplicates } = dedupeJournal(clean);
  return { usable: unique, fabricated, duplicates };
}

/** The usable rows alone, for the readers that need nothing else. */
export function usableJournal(entries: JournalEntry[]): JournalEntry[] {
  return partitionJournal(entries).usable;
}

/**
 * What the page tells the reader about the gap between the row count and the
 * statistics. Null when there is nothing to explain.
 */
export function quarantineNote(p: JournalPartition): string | null {
  if (p.fabricated.length === 0 && p.duplicates.length === 0) return null;
  const parts: string[] = [];
  if (p.fabricated.length > 0) {
    parts.push(
      `${p.fabricated.length} 筆 ${FABRICATION_FIXED_AT.slice(0, 10)} 以前的自動追蹤紀錄已隔離。` +
        `那段期間監控用「價格是否到達」判定成交，對多單來說方向剛好相反 —— ` +
        `價格只要高於進場價就算成交，於是任何停在原地的舊計畫會在同一個 tick 內` +
        `「進場」又「停利」，記成一筆從未發生的獲利。` +
        `這是 /review 會出現「勝率 100%、一筆虧損都沒有」的原因：那些不是交易。` +
        `進場判定已於 ${FABRICATION_FIXED_AT.slice(0, 10)}（${FABRICATION_FIX_COMMIT}）修好，` +
        `之後的紀錄不受影響。舊資料保留可查，只是不計入任何統計。`,
    );
  }
  if (p.duplicates.length > 0) {
    parts.push(
      `另有 ${p.duplicates.length} 筆與既有紀錄完全相同（同訊號、同方向、同進出場價）的重複列，` +
        `同一筆交易只計一次。`,
    );
  }
  return parts.join("\n");
}

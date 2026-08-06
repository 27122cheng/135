import type { SignalRow } from "@/types/signal";
import type { SignalStore } from "@/lib/db";

/**
 * How many history rows to sift when falling back. Nine symbols refreshed
 * four-hourly is nine rows per run, so this reaches back roughly a day —
 * enough to find a recent row for every symbol without pulling the timeline.
 */
const HISTORY_FALLBACK_LIMIT = 80;

export interface LatestRead {
  rows: SignalRow[];
  source: "latest_signal" | "signals";
  /** Set only when something is wrong enough that the reader should be told. */
  note: string | null;
}

/**
 * The current row per symbol, from `latest_signal` — or from the history table
 * when that comes back empty.
 *
 * The fallback is not belt-and-braces. `latest_signal` was added after the
 * schema had already been applied to live deployments, and `/api/refresh`
 * writes to it inside a `.catch(() => {})` so a missing table cannot fail a
 * refresh that already stored its history row. Both decisions are right on
 * their own, and together they produce exactly one symptom: the scheduled scan
 * runs every four hours, `/history` fills up, and the board reads 已掃描 0/9
 * forever with nothing anywhere saying why.
 *
 * `signals` holds the same signals — `latest_signal` is an upsert convenience,
 * not a different truth — so reading the newest row per symbol from it gives
 * the correct board. The `note` says which table answered, because a board
 * silently running off a fallback is how a missing table survives for weeks.
 */
export async function readLatest(store: SignalStore): Promise<LatestRead> {
  let latestError: string | null = null;
  try {
    const rows = await store.latestPerSymbol();
    if (rows.length > 0) return { rows, source: "latest_signal", note: null };
  } catch (err) {
    latestError = err instanceof Error ? err.message : String(err);
  }

  const history = await store.listSignals({ limit: HISTORY_FALLBACK_LIMIT });
  const newest = new Map<string, SignalRow>();
  // listSignals is ordered generated_at desc, so the first row seen for a
  // symbol is its newest.
  for (const row of history) {
    if (!newest.has(row.symbol)) newest.set(row.symbol, row);
  }
  const rows = [...newest.values()];

  return {
    rows,
    source: "signals",
    note:
      latestError !== null
        ? `latest_signal 讀取失敗（${latestError}），改用 signals 歷史表的最新一筆。到設定頁按「建立資料表」可修好。`
        : rows.length > 0
          ? "latest_signal 是空的，改用 signals 歷史表的最新一筆。多半是這張表還沒建立，到設定頁按「建立資料表」。"
          : null,
  };
}


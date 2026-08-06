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
/**
 * Fill in what a stored row cannot carry, so every reader gets a whole signal.
 *
 * The `signals` table predates several fields and has no column for them —
 * `interventions`, `news_digest`, `direction_tie`, `confidence`. That was
 * harmless while history rows only fed /history, which reads a handful of
 * scalars. The moment the board started falling back to that table, those rows
 * reached the signal card, and `signal.interventions.length` on an undefined
 * threw during render: the detail page went to a black screen reading
 * "Application error: a client-side exception has occurred".
 *
 * Normalising here rather than guarding at each of the twenty-odd use sites.
 * The consumers are right to expect a complete `TradeSignal` — that is what the
 * type promises — so the place to make it true is where storage is turned back
 * into one. The defaults are honest: an empty list means "nothing recorded",
 * which is exactly what a missing column means. `confidence` is deliberately
 * left absent rather than invented; the card recomputes it from the signal.
 */
function completeSignal(row: SignalRow): SignalRow {
  return {
    ...row,
    take_profits: row.take_profits ?? [],
    bias_items: row.bias_items ?? [],
    entry_structures: row.entry_structures ?? [],
    path_obstacles: row.path_obstacles ?? [],
    interventions: row.interventions ?? [],
    data_gaps: row.data_gaps ?? [],
    chart_patterns: row.chart_patterns ?? [],
    news_digest: row.news_digest ?? null,
    plan_backtest: row.plan_backtest ?? null,
    direction_tie: row.direction_tie ?? false,
  };
}

export async function readLatest(store: SignalStore): Promise<LatestRead> {
  let latestError: string | null = null;
  try {
    const rows = await store.latestPerSymbol();
    // Normalised on this path too: a payload written by an older build of the
    // signal builder has the same holes as a history row.
    if (rows.length > 0) {
      return { rows: rows.map(completeSignal), source: "latest_signal", note: null };
    }
  } catch (err) {
    latestError = err instanceof Error ? err.message : String(err);
  }

  const history = await store.listSignals({ limit: HISTORY_FALLBACK_LIMIT });
  const newest = new Map<string, SignalRow>();
  // listSignals is ordered generated_at desc, so the first row seen for a
  // symbol is its newest.
  for (const row of history) {
    if (!newest.has(row.symbol)) newest.set(row.symbol, completeSignal(row));
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


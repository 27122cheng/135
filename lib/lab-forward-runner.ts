import type { CommodityMeta } from "@/types/signal";
import { fetchOHLCV } from "./data-sources/ohlcv";
import { advanceForward } from "./analysis/lab-forward";
import { getSignalStore, type LabTradeRow } from "./db";

/**
 * One advance of the 前進實驗 ledger, shared by the route and the sweep.
 *
 * Lives outside lib/analysis so that module stays pure — it decides what the
 * trades are, this fetches and stores them. Both callers must go through here
 * or the ledger would advance differently depending on who woke it.
 */

/** Enough to cover every condition × direction for years of daily bars. */
export const LEDGER_LIMIT = 4000;

export interface AdvanceResult {
  opened: number;
  resolved: number;
  open: number;
}

export async function advanceLedger(
  meta: CommodityMeta,
  gaps: string[],
): Promise<AdvanceResult> {
  const store = getSignalStore();
  if (!store) throw new Error("未設定資料庫，前進實驗無法記錄");

  // The ordinary 1-year D1 series is the right input here, unlike the lab's
  // backtest: resolving a trade needs the last twenty bars, not ten years of
  // them, and this runs for every symbol on every sweep.
  const d1 = await fetchOHLCV(meta, "D1", gaps);
  if (!d1?.candles?.length) throw new Error("取不到 D1 K 棒，本次未推進");

  // Open trades *and* everything already opened on recent bars: an id that
  // exists must never be opened twice, and a resolved trade still owns its bar.
  const existing: LabTradeRow[] = await store.listLabTrades({
    symbol: meta.symbol,
    limit: LEDGER_LIMIT,
  });
  const { resolved, opened } = advanceForward(meta, d1.candles, existing);
  const closed = await store.resolveLabTrades(resolved);
  const inserted = await store.insertLabTrades(opened);
  return {
    opened: inserted,
    resolved: closed,
    open: existing.filter((t) => t.status === "open").length - closed + inserted,
  };
}

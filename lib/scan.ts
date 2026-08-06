import type { CommodityMeta, SupportedSymbol, TradeSignal } from "@/types/signal";
import { FUNDAMENTALS_CONFIG, type FundamentalsConfig } from "@/config/fundamentals";
import { buildSignalFor } from "./signal-builder";
import { ingestReleases, type IngestedRelease } from "./analysis/data-release";
import { withUserKeys } from "./api-keys";
import { withFreshData } from "./data-sources/free-source";
import { storedApiKeys } from "./settings";
import { getSignalStore } from "./db";

/**
 * One scan, used by every caller.
 *
 * ## Why this exists
 *
 * Telegram and the website were running different scans, and it showed. The
 * alert said "US30 做多 ▲ A" while the site said no-trade; the alert also said
 * "未設定任何 AI 金鑰" while the site was reporting a *spent* quota. Both were
 * telling the truth about themselves:
 *
 *  - **Different keys.** `/api/scan` merged the browser's localStorage keys
 *    (sent as a header) over the stored ones. `/api/refresh` runs from GitHub
 *    Actions with no browser, so it only ever saw `app_settings` — which was
 *    empty, because /settings wrote to localStorage and nowhere else. One path
 *    had a model, the other had the local rules.
 *  - **Different inputs.** The scheduled run ingested new economic releases
 *    before building, so its signals could carry a 即時數據公布 factor the
 *    browser's scan had never seen. Same symbol, same minute, different
 *    evidence, legitimately different grade.
 *  - **Different destinations.** The scheduled run appended to `signals`; the
 *    browser scan only upserted `latest_signal`. So /history and the monitor
 *    saw one stream and the board saw another.
 *
 * None of that is a bug in either route. It is three small divergences that
 * compound into two systems with one name. The fix is not to reconcile them —
 * it is to have one of them.
 *
 * ## What is still allowed to differ
 *
 * Exactly one thing: whether the result is announced. Sending Telegram stays
 * the scheduled run's job, because a button that pushes a notification to your
 * own phone every time you press it trains you to ignore the channel that
 * exists to interrupt you. Everything that decides *what the signal is* is
 * shared.
 */

export interface ScanOptions {
  /**
   * Skip the fresh-cache tiers and actually call the sources.
   *
   * For 重新分析 / 立即全部掃描, where the whole point is that the numbers
   * should be new. Without it a rescan inside the 30-minute OHLCV TTL returned
   * byte-identical inputs and therefore a byte-identical signal, which is how
   * pressing refresh came to mean nothing.
   *
   * Not the default: the scheduled sweep runs every four hours, which is longer
   * than every TTL involved, so forcing there would only spend quota to be told
   * the same thing.
   */
  fresh?: boolean;
  /**
   * Keys the browser supplied on this request, layered over the stored ones.
   *
   * Header first, stored second: a browser carrying its own keys must not have
   * them replaced by whatever the deployment happens to store. Both paths start
   * from the same stored base, so a deployment with keys in `app_settings`
   * behaves identically whether or not a browser is involved.
   */
  extraKeys?: Record<string, string>;
}

export interface ScanResult {
  signal: TradeSignal;
  /** Releases this scan ingested — the same list the scheduled run reports. */
  releases: IngestedRelease[];
  /** Notes from ingestion, already folded into the signal's data_gaps. */
  releaseNotes: string[];
  /** Which key names the server itself holds — for diagnosing this exact class of divergence. */
  serverKeyNames: string[];
}

function configFor(meta: CommodityMeta): FundamentalsConfig {
  return (
    FUNDAMENTALS_CONFIG[meta.symbol as SupportedSymbol] ??
    FUNDAMENTALS_CONFIG.SPX500
  );
}

/**
 * Builds one symbol's signal, with the same keys and the same inputs whoever is
 * asking.
 *
 * Release ingestion runs here rather than in the caller because it is an
 * *input* to the analysis, not a side errand: a CPI print that landed twenty
 * minutes ago changes the 基本面 factors, and a scan that skips the ingest is
 * scoring a different world. It is cheap — a handful of cached FRED series —
 * and both callers now pay the same cost.
 */
export async function runScan(
  meta: CommodityMeta,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const stored = await storedApiKeys().catch(() => ({}) as Record<string, string>);
  const keys = { ...stored, ...(options.extraKeys ?? {}) };

  const releaseGaps: string[] = [];
  const build = async () => {
    // Before the build, so a print that landed since the last run is already in
    // the table when the analysis reads it. Otherwise the first scan after a
    // release records it and scores it one run later.
    const ingest = await ingestReleases(releaseGaps).catch((err: unknown) => ({
      fresh: [] as IngestedRelease[],
      gaps: [`數據公布偵測失敗：${err instanceof Error ? err.message : String(err)}`],
    }));
    const signal = await buildSignalFor(meta, configFor(meta));
    return { signal, ingest };
  };
  const result = await withUserKeys(keys, () =>
    options.fresh ? withFreshData(build) : build(),
  );

  const notes = [...releaseGaps, ...result.ingest.gaps];
  // Folded in rather than returned separately: whatever went wrong fetching a
  // release is part of why this signal looks the way it does, and the card's
  // gap list is where the reader already looks for that.
  if (notes.length > 0) {
    result.signal.data_gaps = [...new Set([...result.signal.data_gaps, ...notes])];
  }

  return {
    signal: result.signal,
    releases: result.ingest.fresh,
    releaseNotes: notes,
    serverKeyNames: Object.keys(stored),
  };
}

/**
 * Stores a scan the same way for every caller: the current row every view
 * reads, and the append-only timeline.
 *
 * Both, from both routes. The browser scan used to write only `latest_signal`,
 * which meant a signal you were looking at could be absent from /history and
 * invisible to the monitor — the board and the timeline disagreeing about what
 * had been analysed. At a 4-hourly auto-scan over nine symbols the extra rows
 * are a few dozen a day, which is not a reason to keep two stores out of step.
 */
export async function storeScan(signal: TradeSignal): Promise<{
  stored: boolean;
  storeError: string | null;
}> {
  const store = getSignalStore();
  if (!store) return { stored: false, storeError: "未設定資料庫，掃描結果無處可存" };
  try {
    await store.saveLatest(signal);
  } catch (err) {
    return { stored: false, storeError: err instanceof Error ? err.message : String(err) };
  }
  try {
    await store.insertSignal(signal);
  } catch (err) {
    // The current row is written; the timeline is a log. Losing the log entry
    // must not cost the caller the signal, but it must be reported.
    return {
      stored: true,
      storeError: `已更新目前訊號，但寫入歷史時間軸失敗：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { stored: true, storeError: null };
}

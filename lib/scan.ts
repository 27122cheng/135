import type { CommodityMeta, SupportedSymbol, TradeSignal } from "@/types/signal";
import { FUNDAMENTALS_CONFIG, defaultFundamentals, type FundamentalsConfig } from "@/config/fundamentals";
import { buildSignalFor } from "./signal-builder";
import { ingestReleases, type IngestedRelease } from "./analysis/data-release";
import { withUserKeys } from "./api-keys";
import { withFreshData } from "./data-sources/free-source";
import { storedApiKeys } from "./settings";
import { getSignalStore, type SignalStore } from "./db";

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
  /**
   * The fundamentals config to scan with. Built-ins resolve their own from
   * FUNDAMENTALS_CONFIG; server-registered custom symbols pass theirs here so
   * the CFTC code and news query the user typed actually get used — without
   * it they would scan on the neutral default and lose their own settings.
   */
  config?: FundamentalsConfig;
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
  // A user-added symbol must never inherit another instrument's config: the
  // SPX500 fallback here meant a custom BTCUSD would have been scored with
  // the S&P's CFTC contract code and news query — wrong evidence presented
  // with full confidence. Unknown symbols get a neutral default instead.
  return (
    FUNDAMENTALS_CONFIG[meta.symbol as SupportedSymbol] ??
    defaultFundamentals(meta.symbol, {
      cotContractCode: null,
      gdeltQuery: `"${meta.label}"`,
      newsKeywords: [meta.label.toLowerCase()],
    })
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

  // Named before the build, because "未設定任何 AI 金鑰" on its own sends the
  // reader to a settings page where they can already see the key sitting there.
  // The keys live in two places and only one of them is visible from a phone:
  // the browser's localStorage, which rides along on a request, and
  // `app_settings`, which is the only thing a GitHub Actions run can read. A
  // signal built by the schedule with an empty `app_settings` says "no keys"
  // while the browser holding them says "quota exhausted", and both are right.
  const aiNames = ["GEMINI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"];
  const hasServerAi = aiNames.some((n) => (stored as Record<string, string>)[n]);
  const hasRequestAi = aiNames.some((n) => options.extraKeys?.[n]);
  const hasEnvAi = aiNames.some((n) => process.env[n]?.trim());
  const keyNote =
    hasServerAi || hasRequestAi || hasEnvAi
      ? null
      : "AI 金鑰在瀏覽器與伺服器兩邊都沒有：排程掃描只讀伺服器端設定，" +
        "到設定頁把金鑰按一次「儲存」就會同時寫入兩邊（每個金鑰旁會出現「排程也有」）";

  const releaseGaps: string[] = [];
  const build = async () => {
    // Before the build, so a print that landed since the last run is already in
    // the table when the analysis reads it. Otherwise the first scan after a
    // release records it and scores it one run later.
    const ingest = await ingestReleases(releaseGaps).catch((err: unknown) => ({
      fresh: [] as IngestedRelease[],
      gaps: [`數據公布偵測失敗：${err instanceof Error ? err.message : String(err)}`],
    }));
    const signal = await buildSignalFor(meta, options.config ?? configFor(meta));
    return { signal, ingest };
  };
  const result = await withUserKeys(keys, () =>
    options.fresh ? withFreshData(build) : build(),
  );

  const notes = [...releaseGaps, ...result.ingest.gaps, ...(keyNote ? [keyNote] : [])];
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
/**
 * Re-reads what was just written, and names each table that came back without
 * the new row.
 *
 * This exists because "the write threw" stopped being the only way to lose
 * data. A full day of hourly sweeps reported `storeError: null` on every
 * symbol while the board and the monitor kept reading a world frozen at the
 * previous morning — the inserts were accepted and committed, but by a
 * database no later request ever saw again. That happens when the platform
 * mints a fresh database branch per deployment (Vercel's Neon integration can
 * be configured to): each push sends writes to a branch the next deployment
 * abandons. No exception is ever thrown anywhere, so the only way to catch it
 * is to ask the database, immediately, whether it still has what it just took.
 */
async function readBackMissing(store: SignalStore, signal: TradeSignal): Promise<string[]> {
  // Slack for timestamp round-tripping; anything at-or-after the write counts,
  // including a newer row a concurrent scan may have stored meanwhile.
  const wroteAt = Date.parse(signal.generated_at) - 5_000;
  const freshEnough = (v: unknown) => {
    const t = Date.parse(String(v ?? ""));
    return Number.isFinite(t) && t >= wroteAt;
  };
  const [latest, history] = await Promise.all([
    store.latestPerSymbol(),
    store.listSignals({ symbol: signal.symbol, limit: 1 }),
  ]);
  const missing: string[] = [];
  if (!freshEnough(latest.find((r) => r.symbol === signal.symbol)?.generated_at)) {
    missing.push("latest_signal");
  }
  if (!freshEnough(history[0]?.generated_at)) missing.push("signals");
  return missing;
}

export async function storeScan(
  signal: TradeSignal,
  // Injectable for tests only; every real caller uses the configured store.
  store: SignalStore | null = getSignalStore(),
): Promise<{
  stored: boolean;
  storeError: string | null;
}> {
  if (!store) return { stored: false, storeError: "未設定資料庫，掃描結果無處可存" };

  // Independently, and both attempted whatever the other does.
  //
  // The first cut returned early when `saveLatest` threw, which skipped the
  // timeline write entirely — so a missing or erroring `latest_signal` meant
  // *nothing at all* got stored, and the board froze on whatever row had last
  // succeeded while the scheduled scan kept running and alerting. Before the
  // refactor the refresh route wrote history first and swallowed the upsert
  // failure, so the regression turned a degraded state into a silent one.
  //
  // They fail for different reasons and neither is a reason to skip the other:
  // the timeline is the record, the current row is the view.
  const errors: string[] = [];
  await store.saveLatest(signal).catch((err: unknown) => {
    errors.push(`目前訊號（latest_signal）：${err instanceof Error ? err.message : String(err)}`);
  });
  await store.insertSignal(signal).catch((err: unknown) => {
    errors.push(`歷史時間軸（signals）：${err instanceof Error ? err.message : String(err)}`);
  });

  // Verified only when both writes claimed success: a thrown write is already
  // reported above, and a read-back that itself fails proves nothing about the
  // writes — "couldn't verify" must not masquerade as "lost".
  let lost = false;
  if (errors.length === 0) {
    let missing = await readBackMissing(store, signal).catch(() => [] as string[]);
    if (missing.length > 0) {
      // One beat, then one re-check. The live database proved this necessary:
      // a scan's immediate read-back reported both tables missing the new row
      // while the snapshot query a moment later found it — with counts and a
      // newest_signal stamped the same second. Neon's HTTP path can serve a
      // read a beat behind a commit; a verifier that won't wait one beat
      // reports healthy storage as data loss.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      missing = await readBackMissing(store, signal).catch(() => [] as string[]);
    }
    if (missing.length > 0) {
      lost = missing.length === 2;
      // The database's own account of itself, taken in the same breath as the
      // failed read-back. When this says signal_rows grew while newest_signal
      // stayed frozen, or a different db/role than expected, the culprit is
      // named instead of inferred.
      const who = await store.snapshot?.().catch(() => null);
      const whoLine = who
        ? `。同一連線的資料庫自述：${JSON.stringify(who)}`
        : "";
      errors.push(
        `寫入宣稱成功（RETURNING 有回條），但立刻重讀時 ${missing.join(" 與 ")} 裡都沒有這筆新資料 —— ` +
          "寫入與讀取看到的不是同一份資料。最常見的原因是資料庫整合開啟了" +
          "「每個部署各一個資料庫分支」或端點後方被切換；請到 Neon 控制台用 main 分支" +
          `重新產生連線字串，換掉 Vercel 的 DATABASE_URL${whoLine}`,
      );
    }
  }

  return {
    stored: errors.length < 2 && !lost,
    storeError: errors.length > 0 ? `寫入失敗 — ${errors.join("；")}` : null,
  };
}

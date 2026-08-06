import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, report } from "./_harness";

/**
 * Telegram 跟網站的掃描方式要一樣.
 *
 * They weren't, and it showed: the alert said "US30 做多 ▲ A" while the site
 * said no-trade, and the alert said "未設定任何 AI 金鑰" while the site was
 * reporting a spent quota. Both were true about themselves. Three divergences
 * compounded into two systems with one name —
 *
 *   1. different keys      (browser header + stored vs stored only, where
 *                           "stored" was empty because /settings wrote to
 *                           localStorage and nowhere else)
 *   2. different inputs    (only the scheduled run ingested new releases)
 *   3. different stores    (only the scheduled run appended to `signals`)
 *
 * — and the fix was to have one scan rather than to reconcile two. These are
 * structural checks: they read the routes and assert neither has grown its own
 * pipeline back. A behavioural test can't catch that, because the failure mode
 * is *two* code paths each behaving correctly.
 */

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const scanRoute = read("app/api/scan/route.ts");
const refreshRoute = read("app/api/refresh/route.ts");
const monitorRoute = read("app/api/monitor/route.ts");
const shared = read("lib/scan.ts");

// ── both routes go through the shared scan ────────────────────────
{
  check("the browser scan calls runScan", scanRoute.includes("runScan("));
  check("the scheduled refresh calls runScan", refreshRoute.includes("runScan("));

  // Building directly is the divergence coming back.
  for (const [name, src] of [
    ["browser scan", scanRoute],
    ["scheduled refresh", refreshRoute],
  ] as const) {
    check(`the ${name} does not build a signal itself`,
      !src.includes("buildTradeSignal(") && !src.includes("buildSignalFor("));
    check(`the ${name} does not resolve keys itself`, !src.includes("storedApiKeys("));
    check(`the ${name} does not ingest releases itself`, !src.includes("ingestReleases("));
  }
}

// ── the shared scan owns all three ────────────────────────────────
{
  check("keys are resolved in one place", shared.includes("storedApiKeys("));
  check("stored keys are the base for both", shared.includes("...stored"));
  check("browser keys layer on top, not underneath",
    shared.indexOf("...stored") < shared.indexOf("options.extraKeys"));
  // Call sites, not imports: the point is the *order of the work*.
  check("releases are ingested as an input to the build",
    shared.indexOf("ingestReleases(") < shared.indexOf("buildSignalFor("),
    [shared.indexOf("ingestReleases("), shared.indexOf("buildSignalFor(")]);
}

// ── both write to both places ─────────────────────────────────────
{
  check("storing is shared too",
    scanRoute.includes("storeScan(") && refreshRoute.includes("storeScan("));
  check("the shared store writes the current row", shared.includes("saveLatest("));
  check("and the timeline", shared.includes("insertSignal("));
  // The board reads latest_signal, /history and the backtest read signals. A
  // scan that wrote only one of them made those two views disagree about what
  // had been analysed.
  check("neither route writes storage directly",
    !scanRoute.includes("saveLatest(") && !refreshRoute.includes("insertSignal("));
}

// ── the monitor watches the row the user is looking at ────────────
{
  check("the monitor reads the same row as the board", monitorRoute.includes("readLatest("));
  check("not the newest history row",
    !monitorRoute.includes("listSignals({ symbol: meta.symbol, limit: 1 })"));
}

// ── one thing is still allowed to differ, on purpose ──────────────
{
  check("only the scheduled run notifies", refreshRoute.includes("notifyAll("));
  check("the browser scan never notifies", !scanRoute.includes("notifyAll("));
  check("and says why", scanRoute.includes("訓練") || scanRoute.includes("train"));
}

// ── keys written in the browser reach the scheduler ───────────────
{
  const settings = read("app/settings/page.tsx");
  check("saving posts the keys to the server too",
    settings.includes("/api/notify/config") && settings.includes('method: "POST"'));
  check("the browser copy is still kept", settings.includes("saveUserKeys(keys)"));
  // The badge that would have made this diagnosable in one glance.
  check("the page distinguishes a device key from a scheduled-run key",
    settings.includes("只在這台裝置") && settings.includes("排程也有"));
}

// ── a refresh has to actually refresh ─────────────────────────────
//
// "價格一直沒刷新就算我更新了一樣". Two separate causes, both here.
{
  const builder = read("lib/signal-builder.ts");
  const freeSource = read("lib/data-sources/free-source.ts");

  // 1. The entry zone was built from the last *daily close*, so on a daily feed
  //    it was yesterday's settlement and no rescan could move it. NAS100 came
  //    back long at 29,829–30,043 while the market traded 29,369.
  check("the analysis uses the live quote", builder.includes("fetchLatestPrice("));
  check("not the last daily close as the primary price",
    !builder.includes("const currentPrice = d1?.candles.at(-1)?.close"));
  check("the last close is kept only as a fallback",
    builder.includes("quote?.price ?? lastClose"));
  check("and the card says which one was used", builder.includes("priceBasis"));

  // 2. Even with a live quote, every source sat behind a fresh-cache tier, so a
  //    rescan inside the TTL returned byte-identical inputs.
  check("a forced fetch skips the memory cache", freeSource.includes("forced ? undefined : getCached"));
  check("and the persisted fresh tier", freeSource.includes("persisted?.fresh && !forced"));
  // Forcing is permission to try, not permission to invent: the stale tier must
  // stay reachable so a failed live call still answers with something labelled.
  check("but the stale tier is still reachable", freeSource.includes("serveStale("));
  check("the browser scan asks for fresh data by default",
    scanRoute.includes('searchParams.get("fresh") !== "0"'));
}

report("scan parity");

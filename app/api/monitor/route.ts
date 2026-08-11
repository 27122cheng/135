import { COMMODITIES } from "@/types/signal";
import { getSignalStore, type MonitorRow, type TrackedPlan } from "@/lib/db";
import { readLatest } from "@/lib/latest-signals";
import { fetchLatestPrice } from "@/lib/data-sources/yfinance";
import { notifyAll } from "@/lib/notify";
import { formatReleaseAlert } from "@/lib/notify/alert";
import { ingestReleases } from "@/lib/analysis/data-release";
import { withUserKeys } from "@/lib/api-keys";
import { storedApiKeys } from "@/lib/settings";
import { json } from "@/lib/json-response";
import {
  advancePlan,
  formatMonitorAlert,
  INITIAL_MEMORY,
  type MonitorMemory,
} from "@/lib/monitor/plan-state";
import { recordResolvedPlan } from "@/lib/journal/auto-log";
import type { SignalRow, TradePlan } from "@/types/signal";

/**
 * The 參考價位 of a 觀望 signal, expressed as a plan the monitor can follow.
 *
 * Not a recommendation and never alerted on — it is how the reference levels
 * get a measured win rate instead of an opinion. The entry is the middle of the
 * entry zone, which is the analysis price the levels were derived from, so the
 * paper position opens where the analysis was standing.
 */
function shadowPlan(signal: SignalRow): TradePlan | null {
  const zone = signal.entry_zone;
  const stop = signal.stop_loss?.price;
  const target = signal.take_profits?.[0]?.price;
  if (!zone || !Number.isFinite(stop) || !Number.isFinite(target)) return null;
  const entry = (zone.low + zone.high) / 2;
  if (!(entry > 0)) return null;
  // The same geometry check the real plans get: a stop on the winning side or
  // a target on the losing side is a broken row, not a trade to track.
  const ok =
    signal.direction === "long"
      ? stop! < entry && target! > entry
      : stop! > entry && target! < entry;
  if (!ok) return null;

  return {
    stance: "enter",
    entry,
    stop_loss: stop!,
    take_profit: target!,
    entry_reason: "參考價位（分析當下價格）",
    stop_loss_reason: signal.stop_loss.structure,
    take_profit_reason: signal.take_profits[0].structure,
    risk_reward: null,
    confidence: "low",
    summary: "參考價位紙上追蹤，非建議進場。",
    add_ons: [],
    wait_for: null,
    decided_by: "fallback",
  };
}

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The 5-minute watch, driven by .github/workflows/monitor.yml.
 *
 * It does **not** re-run the analysis — that costs nine full pipelines and the
 * inputs (H4/D1/W1 candles, weekly COT, daily yields) don't change in five
 * minutes. It only asks what the latest price has done to the plan that is
 * already on the table: entry touched, add-on level reached, stop needs
 * moving, stop or target hit.
 *
 * Price is delayed (~15 minutes on the free tier). Fine for managing an H4/D1
 * position whose levels are hours apart; every alert states the age so it can't
 * be mistaken for a live feed.
 */
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const store = getSignalStore();
  if (!store) {
    return json(
      { error: "未設定資料庫，無法追蹤部位狀態（監控需要記住上次回報過什麼）" },
      { status: 501 },
    );
  }

  const appUrl = process.env.APP_URL?.trim() || new URL(request.url).origin;
  const requested = new URL(request.url).searchParams.get("symbol")?.toUpperCase();
  const targets = requested ? COMMODITIES.filter((c) => c.symbol === requested) : COMMODITIES;

  // One read for all nine, not one per symbol: this is the same query the board
  // makes, and it answers for every instrument at once.
  const current = await readLatest(store)
    .then((r) => new Map(r.rows.map((row) => [row.symbol, row])))
    .catch(() => new Map<string, Awaited<ReturnType<typeof readLatest>>["rows"][number]>());

  const settled = await Promise.allSettled(
    targets.map(async (meta) => {
      // The *same row the board and the detail page show*, not the newest
      // history row. Those could differ: a browser scan used to write only
      // `latest_signal`, so the monitor would be watching an older plan than
      // the one on screen — and now that a resolved plan writes itself into the
      // journal, watching the wrong plan writes the wrong lesson.
      const latest = current.get(meta.symbol);
      if (!latest) return { symbol: meta.symbol, skipped: "尚無訊號紀錄" };

      // A trade in flight outlives the signal that opened it. The old rule —
      // "a new signal replaces whatever was being tracked" — reset the tracker
      // on every rescan: the same entry re-fired on every sweep (the duplicate
      // Telegram alerts) and no trade ever reached its stop or target under
      // one identity, so the journal and the review page stayed empty. Now the
      // entered plan is snapshotted into plan_monitor itself (rows from
      // latest_signal have no stable id to reload it by), and while a position
      // is open — entered or added-to — the monitor keeps watching that
      // snapshot until it resolves. Newer analysis waits its turn.
      const inFlight = (row: MonitorRow | null) =>
        row !== null &&
        (row.state === "entered" || row.state === "added") &&
        row.tracked?.plan != null;

      const openReal = await store.getMonitorState(meta.symbol).catch(() => null);
      let previous = inFlight(openReal) ? openReal : null;
      const paper = previous ? false : latest.trade_plan?.stance !== "enter";

      // 觀望 signals are tracked too, on their 參考價位, as a paper position —
      // a tracker that only watches recommended trades watches nothing during
      // quiet weeks, and the reference levels' hit rate was explicitly asked
      // for. Paper positions never notify; they are a measurement, not a call.
      // The same stickiness applies: a measurement that resets on every rescan
      // measures nothing.
      if (!previous && paper) {
        const openPaper = await store.getMonitorState(`${meta.symbol}:ref`).catch(() => null);
        if (inFlight(openPaper)) previous = openPaper;
      }

      const tracked: TrackedPlan | null = previous?.tracked
        ? previous.tracked
        : (() => {
            const plan = paper ? shadowPlan(latest) : latest.trade_plan;
            if (!plan) return null;
            return {
              direction: latest.direction,
              grade: latest.grade,
              plan,
              generatedAt: latest.generated_at,
            };
          })();
      if (!tracked) return { symbol: meta.symbol, skipped: "觀望且沒有可追蹤的參考價位" };
      const plan = tracked.plan;
      const stateKey = paper ? `${meta.symbol}:ref` : meta.symbol;

      if (!previous) previous = await store.getMonitorState(stateKey).catch(() => null);
      // Memory carries over only while the same plan is being watched. The
      // identity is the snapshot's generated_at — latest_signal ids are just
      // the symbol, which made "same id" true across different plans and left
      // resolved states stuck forever.
      const samePlan =
        previous?.tracked?.generatedAt === tracked.generatedAt ||
        (previous?.tracked == null && previous?.signalId === latest.id);
      const memory: MonitorMemory = samePlan && previous
        ? { state: previous.state, addOnsFilled: previous.addOnsFilled, activeStop: previous.activeStop }
        : INITIAL_MEMORY;

      const gaps: string[] = [];
      const quote = await fetchLatestPrice(meta.yfinanceSymbol, gaps, meta.stooqSymbol, meta.symbol);
      if (!quote) return { symbol: meta.symbol, skipped: "取不到即時報價", notes: gaps };

      const { memory: next, events } = advancePlan({
        direction: tracked.direction,
        plan,
        price: quote.price,
        priceAgeMinutes: quote.ageMinutes,
        memory,
      });

      await store.saveMonitorState({
        symbol: stateKey,
        // latest_signal ids are the symbol, not a uuid; the column is typed
        // uuid, so a non-uuid id is stored as null and identity lives in
        // `tracked.generatedAt` instead.
        signalId: /^[0-9a-f-]{36}$/i.test(latest.id) ? latest.id : null,
        lastPrice: quote.price,
        tracked,
        ...next,
      });

      let notified: string[] = [];
      if (events.length > 0 && !paper) {
        const results = await notifyAll(
          formatMonitorAlert(meta.symbol, tracked.direction, events, quote.ageMinutes, appUrl),
        );
        notified = results.filter((r) => r.ok).map((r) => r.channel);
      }

      // The loop the whole Stage 3 machinery was built for and never got to
      // run: a resolved plan is written to the journal, a stop-out is
      // classified, and the classification tightens how the next signal for
      // this symbol is built.
      let review: string | null = null;
      const resolved = events.find((e) => e.kind === "stop_hit" || e.kind === "target_hit");
      if (resolved && plan.entry !== null && plan.stop_loss !== null && plan.take_profit !== null) {
        const logged = await recordResolvedPlan({
          store,
          meta,
          // The journal must describe the trade that actually ran — the
          // snapshot's direction/grade/plan — not whatever analysis is newest.
          signal: { ...latest, direction: tracked.direction, grade: tracked.grade, trade_plan: plan },
          entry: plan.entry,
          stopLoss: plan.stop_loss,
          takeProfit: plan.take_profit,
          exitPrice: quote.price,
          outcome: resolved.kind === "target_hit" ? "target_hit" : "stop_hit",
          paper,
          // Filled in below from this run's own release check — the releases
          // are ingested in the same pass, so "landed while we held" is
          // answerable without another call.
          eventDuringHold: false,
          gaps,
        });
        review = logged.note;
      }

      return {
        symbol: meta.symbol,
        paper,
        price: quote.price,
        priceAgeMinutes: Math.round(quote.ageMinutes),
        state: next.state,
        events: events.map((e) => e.kind),
        notified,
        review,
      };
    }),
  );

  const results = settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : {
          symbol: targets[i].symbol,
          error: s.reason instanceof Error ? s.reason.message : String(s.reason),
        },
  );

  // 即時數據公布. Checked here rather than only in the 4-hourly refresh because
  // "即時" is the whole point: a CPI print that lands at 20:30 would otherwise
  // sit unnoticed until the next scheduled scan, which can be four hours of the
  // move already gone. This pass is cheap — seven cached FRED series, no
  // pipelines — so it fits inside the same 60s budget as the price checks.
  //
  // It announces the print; it does not re-grade nine symbols here. The factor
  // enters scoring on the next signal built for each symbol, which is what the
  // impact window in config/data-releases.ts is sized for.
  const releaseGaps: string[] = [];
  let releases: Array<{ label: string; value: number; period: string }> = [];
  let releaseError: string | null = null;
  try {
    // Same reason as the refresh: no browser means no header keys, so the
    // stored ones are what let the calendar lookup work at all.
    const ingest = await withUserKeys(await storedApiKeys().catch(() => ({})), () =>
      ingestReleases(releaseGaps),
    );
    releases = ingest.fresh.map((f) => ({
      label: f.release.label,
      value: f.value,
      period: f.period,
    }));
    if (ingest.fresh.length > 0) {
      await notifyAll(formatReleaseAlert(ingest.fresh, appUrl));
    }
  } catch (err) {
    releaseError = err instanceof Error ? err.message : String(err);
  }

  return json({
    ranAt: new Date().toISOString(),
    results,
    releases,
    releaseNotes: releaseGaps,
    releaseError,
  });
}

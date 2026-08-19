import { COMMODITIES } from "@/types/signal";
import { getSignalStore, type MonitorRow, type TrackedPlan } from "@/lib/db";
import { readLatest } from "@/lib/latest-signals";
import { fetchLatestPrice } from "@/lib/data-sources/yfinance";
import { notifyAll } from "@/lib/notify";
import { upcomingHighImpactEvent } from "@/lib/analysis/timing";
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
import { maybeSendWeeklyDigest } from "@/lib/notify/weekly-digest";
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
  // Only the vetted reference plan is paper-tracked — the levels that passed
  // the 55% hit-rate floor and the 1:1.5 payoff floor. The raw computed
  // levels used to be tracked here, which measured geometry no rule had
  // approved; a win rate for levels nobody vetted answers a question nobody
  // asked.
  const ref = signal.reference_plan;
  if (!ref) return null;
  const { entry, stop_loss: stop, take_profit: target } = ref;
  if (![entry, stop, target].every(Number.isFinite) || !(entry > 0)) return null;
  // The same geometry check the real plans get: a stop on the winning side or
  // a target on the losing side is a broken row, not a trade to track.
  const ok =
    signal.direction === "long" ? stop < entry && target > entry : stop > entry && target < entry;
  if (!ok) return null;

  return {
    stance: "enter",
    entry,
    stop_loss: stop,
    take_profit: target,
    entry_reason: ref.entry_reason,
    stop_loss_reason: ref.stop_reason,
    take_profit_reason: ref.target_reason,
    risk_reward: ref.risk_reward,
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

      // A frozen feed judges nothing. Three identical XAUUSD 進場+停利 pushes
      // went out on quotes their own footer dated 810, 840 and 870 minutes
      // old — a price that has not moved in 13 hours cannot fill an entry or
      // hit a target; it can only replay whatever the levels already implied.
      // Same 3-hour liveness bound the market-hours gate uses for its quote
      // witness: past it, this round observes and decides nothing.
      const MAX_QUOTE_AGE_MINUTES = 180;
      if (quote.ageMinutes > MAX_QUOTE_AGE_MINUTES) {
        return {
          symbol: meta.symbol,
          priceAgeMinutes: Math.round(quote.ageMinutes),
          skipped:
            `報價已 ${Math.round(quote.ageMinutes)} 分鐘未更新（超過 ${MAX_QUOTE_AGE_MINUTES} 分鐘門檻），` +
            "市場休市或價格來源停更，本輪不判定進出場",
        };
      }

      const { memory: next, events } = advancePlan({
        direction: tracked.direction,
        plan,
        price: quote.price,
        priceAgeMinutes: quote.ageMinutes,
        memory,
      });

      // No memory, no mouth. If this state cannot be persisted, the next
      // sweep will believe nothing happened and fire the identical events
      // again — the duplicate 已觸及進場 pushes were exactly this loop. An
      // event that cannot be remembered is not announced and not journalled;
      // the error is reported instead, once, here.
      try {
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
        // The write that lies: a save that throws is already handled below,
        // but a save the database accepts and then forgets never throws — it
        // just resets the state machine, and the next sweep replays the same
        // entered/stop/target push. That exact loop ran three times in an
        // afternoon. So the save is read back; a state that cannot be re-read
        // is treated as unsaved, and no-memory-no-mouth applies. One beat of
        // patience before the verdict — Neon's HTTP reads can trail a commit
        // by a moment, and an instant re-read reported healthy saves as lost.
        const matches = (echo: MonitorRow | null) =>
          echo?.state === next.state && echo?.tracked?.generatedAt === tracked.generatedAt;
        let echo = await store.getMonitorState(stateKey);
        if (!matches(echo)) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          echo = await store.getMonitorState(stateKey);
        }
        if (!matches(echo)) {
          throw new Error(
            "狀態寫入後重讀兩次都讀不回 —— 資料庫收下了寫入卻沒有留住" +
              "（最常見原因：資料庫整合替每個部署開新分支，DATABASE_URL 需改為固定分支）",
          );
        }
      } catch (err) {
        return {
          symbol: meta.symbol,
          paper,
          price: quote.price,
          state: next.state,
          events: events.map((e) => e.kind),
          notified: [],
          review: null,
          saveError: `監控狀態寫入失敗，本輪事件不通知不記錄（否則每輪重播）：${err instanceof Error ? err.message : String(err)}`,
        };
      }

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

  // 數據前的持倉警告 — the S4 intervention downgrades *new* signals ahead of
  // NFP and FOMC; nothing was telling the person already in a trade. When a
  // clock-derivable release is inside two hours and real positions are open,
  // one push lists them with the standard playbook (reduce or tighten).
  //
  // Deduped through the release table's first-writer-wins insert — the same
  // mechanism that stops a CPI print being announced twice — because this
  // route runs every five minutes and a two-hour window would otherwise fire
  // twenty-four times. One row per event occurrence, not per symbol: one push
  // naming all held symbols beats nine phones buzzing separately.
  let eventWarning: string | null = null;
  try {
    const event = upcomingHighImpactEvent(new Date(), 2 * 60 * 60 * 1000);
    const held = results.filter(
      (r): r is typeof r & { symbol: string; state: string; paper: boolean } =>
        "state" in r &&
        (r.state === "entered" || r.state === "added") &&
        "paper" in r &&
        r.paper === false,
    );
    if (event && held.length > 0) {
      const receipt = await store.recordRelease({
        seriesId: "event-warning",
        period: event.at.toISOString(),
        value: 0,
        previousValue: null,
        estimate: null,
      });
      if (receipt.isNew) {
        const hours = Math.floor(event.minutesAway / 60);
        const minutes = event.minutesAway % 60;
        eventWarning =
          `⚠️ ${hours > 0 ? `${hours} 小時 ` : ""}${minutes} 分鐘後公布${event.label}。` +
          `目前持倉中：${held.map((h) => h.symbol).join("、")}。` +
          `數據前後的行情不是技術面能預測的 —— 考慮減半部位或把停損收緊到保本，` +
          `不要在公布前加倉。`;
        await notifyAll(eventWarning);
      }
    }
  } catch {
    // A failed warning must not fail the monitoring that just ran.
  }

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

  // 週結摘要 — piggybacks on the most frequent schedule; its own window and
  // once-per-week marker live in lib/notify/weekly-digest.ts. A failure here
  // must not fail the monitoring that just ran.
  const digest = await maybeSendWeeklyDigest(store, appUrl).catch((err: unknown) => ({
    sent: false,
    reason: `週結摘要失敗：${err instanceof Error ? err.message : String(err)}`,
  }));

  return json({
    ranAt: new Date().toISOString(),
    results,
    releases,
    releaseNotes: releaseGaps,
    releaseError,
    weeklyDigest: digest.sent ? digest.reason : undefined,
  });
}

import { COMMODITIES } from "@/types/signal";
import { getSignalStore } from "@/lib/db";
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

  const settled = await Promise.allSettled(
    targets.map(async (meta) => {
      // The newest stored signal is the plan in force.
      const [latest] = await store.listSignals({ symbol: meta.symbol, limit: 1 });
      if (!latest) return { symbol: meta.symbol, skipped: "尚無訊號紀錄" };
      if (latest.trade_plan?.stance !== "enter") {
        return { symbol: meta.symbol, skipped: "目前是觀望，無部位可追蹤" };
      }

      const previous = await store.getMonitorState(meta.symbol);
      // A new signal replaces whatever was being tracked — the old plan's
      // state says nothing about this one's levels.
      const memory: MonitorMemory =
        previous && previous.signalId === latest.id
          ? { state: previous.state, addOnsFilled: previous.addOnsFilled, activeStop: previous.activeStop }
          : INITIAL_MEMORY;

      const gaps: string[] = [];
      const quote = await fetchLatestPrice(meta.yfinanceSymbol, gaps);
      if (!quote) return { symbol: meta.symbol, skipped: "取不到即時報價", notes: gaps };

      const { memory: next, events } = advancePlan({
        direction: latest.direction,
        plan: latest.trade_plan,
        price: quote.price,
        priceAgeMinutes: quote.ageMinutes,
        memory,
      });

      await store.saveMonitorState({
        symbol: meta.symbol,
        signalId: latest.id,
        lastPrice: quote.price,
        ...next,
      });

      let notified: string[] = [];
      if (events.length > 0) {
        const results = await notifyAll(
          formatMonitorAlert(meta.symbol, latest.direction, events, quote.ageMinutes, appUrl),
        );
        notified = results.filter((r) => r.ok).map((r) => r.channel);
      }

      return {
        symbol: meta.symbol,
        price: quote.price,
        priceAgeMinutes: Math.round(quote.ageMinutes),
        state: next.state,
        events: events.map((e) => e.kind),
        notified,
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

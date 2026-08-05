import { COMMODITIES } from "@/types/signal";
import { getSignalStore } from "@/lib/db";
import { fetchLatestPrice } from "@/lib/data-sources/yfinance";
import { notifyAll } from "@/lib/notify";
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

  return json({ ranAt: new Date().toISOString(), results });
}

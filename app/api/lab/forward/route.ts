import { COMMODITIES } from "@/types/signal";
import { summariseForward } from "@/lib/analysis/lab-forward";
import { advanceLedger, LEDGER_LIMIT } from "@/lib/lab-forward-runner";
import { getSignalStore } from "@/lib/db";
import { applyStoredTradingCosts } from "@/lib/settings";
import { json } from "@/lib/json-response";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 前進實驗 — the ledger of paper trades each condition is running live.
 *
 * GET reads it. POST advances it: resolve what the new bars settled, open what
 * the newest bar triggers. The advance is idempotent per bar — trade ids are
 * derived from the entry bar — so calling it twice in one day writes nothing
 * the first call did not already write, which is what makes it safe to run
 * from the 4-hourly sweep *and* from a button on the page.
 *
 * The ordinary 1-year D1 series is deliberately the right input here, unlike
 * the lab's backtest: resolving a trade needs the last twenty bars, not ten
 * years of them, and this runs on every sweep for every symbol.
 */

export async function GET(request: Request) {
  const store = getSignalStore();
  if (!store) {
    return json(
      { error: "未設定資料庫，前進實驗無法記錄", trades: [], stats: [] },
      { status: 501 },
    );
  }
  const params = new URL(request.url).searchParams;
  const symbol = params.get("symbol")?.toUpperCase() ?? null;
  const direction = params.get("direction") === "short" ? "short" : params.get("direction") === "long" ? "long" : null;
  try {
    // The stats column charges costs; use the operator's figures when set.
    await applyStoredTradingCosts();
    const trades = await store.listLabTrades({ symbol, direction, limit: LEDGER_LIMIT });
    return json({
      stats: summariseForward(trades),
      // The newest handful, so the page can show that real rows exist with
      // real prices rather than only an aggregate.
      recent: trades.slice(0, 20),
      total: trades.length,
      open: trades.filter((t) => t.status === "open").length,
      since: trades.length > 0 ? trades[trades.length - 1].entryBarTime : null,
    });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : String(err), stats: [], recent: [] },
      { status: 502 },
    );
  }
}

/**
 * Advances the ledger. `?symbol=` does one; without it, all nine — which is
 * the shape the sweep calls it in, and it stays inside the function ceiling
 * because the candles are already cached by the scan that just ran.
 */
export async function POST(request: Request) {
  const store = getSignalStore();
  if (!store) return json({ error: "未設定資料庫，前進實驗無法記錄" }, { status: 501 });

  const requested = new URL(request.url).searchParams.get("symbol")?.toUpperCase();
  const targets = requested ? COMMODITIES.filter((c) => c.symbol === requested) : COMMODITIES;
  if (targets.length === 0) return json({ error: `Unknown symbol ${requested}` }, { status: 404 });

  const gaps: string[] = [];
  await applyStoredTradingCosts();
  const results = await Promise.allSettled(targets.map((meta) => advanceLedger(meta, gaps)));
  const report = results.map((r, i) =>
    r.status === "fulfilled"
      ? { symbol: targets[i].symbol, ...r.value }
      : {
          symbol: targets[i].symbol,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        },
  );
  return json({ ranAt: new Date().toISOString(), results: report, gaps: [...new Set(gaps)] });
}

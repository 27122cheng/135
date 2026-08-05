import { COMMODITIES, type AddOnLevel, type Grade, type SignalRow } from "@/types/signal";
import { getSignalStore } from "@/lib/db";
import { json } from "@/lib/json-response";

export const dynamic = "force-dynamic";

/**
 * 交易總覽 — every symbol's current plan, in one request.
 *
 * Reads the stored signals rather than building them. That is the whole point:
 * a full pipeline per symbol is what made switching instruments a long wait,
 * and the scheduled refresh has already paid that cost for all nine. This is a
 * single query over the results.
 *
 * The payload is deliberately narrow — direction, grade, the three prices and
 * whether add-ons exist. A signal row carries bias items, structures,
 * obstacles, the narrative and the gap list; shipping all of that to a page
 * that shows a list would make the "instant" board slower than the thing it
 * replaced.
 */

export interface BoardAddOn {
  sequence: number;
  price: number;
  structure: string;
  new_stop_loss: number;
}

export interface BoardRow {
  symbol: string;
  label: string;
  category: string;
  /** Null when this symbol has never been scanned. */
  signalId: string | null;
  direction: "long" | "short" | null;
  /** True when the factors cancelled out — show 中性, not a direction. */
  directionTie: boolean;
  grade: Grade | null;
  /** "enter" is the only one that means there is a trade. */
  stance: "enter" | "wait" | null;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskReward: number | null;
  addOns: BoardAddOn[];
  summary: string | null;
  waitFor: string | null;
  generatedAt: string | null;
  /** How many data gaps the scan reported — a count, not the list. */
  gapCount: number;
}

function toBoardRow(meta: (typeof COMMODITIES)[number], row: SignalRow | undefined): BoardRow {
  const base = {
    symbol: meta.symbol,
    label: meta.label,
    category: meta.category,
  };
  if (!row) {
    return {
      ...base,
      signalId: null,
      direction: null,
      directionTie: false,
      grade: null,
      stance: null,
      entry: null,
      stopLoss: null,
      takeProfit: null,
      riskReward: null,
      addOns: [],
      summary: null,
      waitFor: null,
      generatedAt: null,
      gapCount: 0,
    };
  }

  const plan = row.trade_plan;
  return {
    ...base,
    signalId: row.id,
    direction: row.direction,
    directionTie: row.direction_tie === true,
    grade: row.grade,
    stance: plan?.stance ?? null,
    entry: plan?.entry ?? null,
    stopLoss: plan?.stop_loss ?? null,
    takeProfit: plan?.take_profit ?? null,
    riskReward: plan?.risk_reward ?? null,
    addOns: (plan?.add_ons ?? []).map((a: AddOnLevel) => ({
      sequence: a.sequence,
      price: a.price,
      structure: a.structure,
      new_stop_loss: a.new_stop_loss,
    })),
    summary: plan?.summary ?? null,
    waitFor: plan?.wait_for ?? null,
    generatedAt: row.generated_at,
    gapCount: Array.isArray(row.data_gaps) ? row.data_gaps.length : 0,
  };
}

export async function GET(request: Request) {
  const wanted = new URL(request.url).searchParams.get("symbol")?.toUpperCase();
  const store = getSignalStore();
  if (!store) {
    return json(
      {
        error: "未設定資料庫",
        next: "總覽讀的是掃描寫進資料庫的結果。到 /setup 建立資料表。",
        rows: [],
      },
      { status: 501 },
    );
  }

  try {
    const latest = await store.latestPerSymbol();
    const bySymbol = new Map(latest.map((r) => [r.symbol, r]));

    // `?symbol=` returns the full stored signal, which is what the detail page
    // renders. Same row, same endpoint — the board and the analysis page
    // cannot show different numbers because there is only one number.
    if (wanted) {
      const row = bySymbol.get(wanted);
      return json({ signal: row ?? null }, { status: row ? 200 : 404 });
    }
    // Driven by COMMODITIES, not by what the query returned, so a symbol that
    // has never been scanned appears as an empty row instead of vanishing —
    // "no data yet" and "no trade" are different answers.
    const rows = COMMODITIES.map((meta) => toBoardRow(meta, bySymbol.get(meta.symbol)));

    return json({
      rows,
      tradeCount: rows.filter((r) => r.stance === "enter").length,
      scannedCount: rows.filter((r) => r.generatedAt !== null).length,
      oldestAt: rows.reduce<string | null>(
        (oldest, r) =>
          r.generatedAt && (!oldest || r.generatedAt < oldest) ? r.generatedAt : oldest,
        null,
      ),
    });
  } catch (err) {
    return json(
      {
        error: err instanceof Error ? err.message : String(err),
        next: "latest_signal 資料表可能還沒建立。到 /setup 按「建立資料表」。",
        rows: [],
      },
      { status: 500 },
    );
  }
}

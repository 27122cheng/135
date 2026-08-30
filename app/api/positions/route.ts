import { COMMODITIES } from "@/types/signal";
import { allInstruments } from "@/lib/server-symbols";
import { getSignalStore, type MonitorRow } from "@/lib/db";
import { readLatest } from "@/lib/latest-signals";
import { usdExposure } from "@/lib/board-row";
import { json } from "@/lib/json-response";

export const dynamic = "force-dynamic";

/**
 * 持倉 — what the monitor is actually holding, which nothing showed before.
 *
 * The 5-minute monitor has tracked entries, add-ons, stop moves and
 * resolutions since Stage 3, all of it in `plan_monitor`, and the only way to
 * see any of it was a Telegram push or a workflow log. So a position could be
 * open for two days with its stop already moved to breakeven and the site
 * would show the same 觀望 card as an instrument nobody had touched.
 *
 * Read-only and cheap: one monitor row per symbol plus the board's own
 * latest-signal read for the plan behind each. No prices are fetched — the
 * monitor already stamps its last observed price, and refetching nine quotes
 * to render a page would spend the budget the monitor runs on.
 */

export interface PositionRow {
  symbol: string;
  label: string;
  category: string;
  /** "entered" / "added" / "scaled" are live; the rest are history for this plan. */
  state: string;
  direction: "long" | "short" | null;
  grade: string | null;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  /** The stop currently in force — may be tighter than the plan's original. */
  activeStop: number | null;
  /** True once the stop has been moved off its starting level. */
  stopMoved: boolean;
  addOnsFilled: number;
  lastPrice: number | null;
  /** Unrealised move as a multiple of the original risk. Null without prices. */
  openR: number | null;
  /** 紙上追蹤 — a reference plan nobody was told to take. */
  paper: boolean;
  openedAt: string | null;
}

function toRow(
  meta: { symbol: string; label: string; category: string },
  row: MonitorRow,
  paper: boolean,
): PositionRow | null {
  const tracked = row.tracked;
  const plan = tracked?.plan;
  if (!plan) return null;

  const entry = plan.entry ?? null;
  const original = plan.stop_loss ?? null;
  const active = row.activeStop ?? original;
  const price = row.lastPrice ?? null;

  // R is measured against the *original* risk, always. Once the stop moves to
  // breakeven the live risk is zero, and dividing by it would report every
  // protected trade as infinitely profitable.
  const risk = entry !== null && original !== null ? Math.abs(entry - original) : null;
  const openR =
    price !== null && entry !== null && risk !== null && risk > 0
      ? Math.round(
          ((tracked.direction === "long" ? price - entry : entry - price) / risk) * 100,
        ) / 100
      : null;

  return {
    symbol: meta.symbol,
    label: meta.label,
    category: meta.category,
    state: row.state,
    direction: tracked.direction,
    grade: tracked.grade ?? null,
    entry,
    stopLoss: original,
    takeProfit: plan.take_profit ?? null,
    activeStop: active,
    stopMoved: active !== null && original !== null && active !== original,
    addOnsFilled: row.addOnsFilled ?? 0,
    lastPrice: price,
    openR,
    paper,
    openedAt: tracked.generatedAt ?? null,
  };
}

export async function GET() {
  const store = getSignalStore();
  if (!store) {
    return json(
      { error: "未設定資料庫", next: "持倉狀態存在資料庫，到設定頁建立資料表。", rows: [] },
      { status: 501 },
    );
  }

  try {
    // 自訂標的的持倉也是持倉 —— this read was COMMODITIES.map, so a BTCUSD
    // position the monitor had entered, was managing, and had already pushed
    // to Telegram was never even queried here: the page reported 「沒有追蹤
    // 中的部位」 about a trade that was live. The monitor, the refresh sweep
    // and the digest all resolve through the roster; this was the one that
    // did not.
    const roster = await allInstruments().catch(() => [...COMMODITIES]);
    const settled = await Promise.all(
      roster.map(async (meta) => {
        // Real plans and paper (參考價位) plans are tracked under different
        // keys by the monitor; both belong here, labelled apart.
        const [real, paper] = await Promise.all([
          store.getMonitorState(meta.symbol).catch(() => null),
          store.getMonitorState(`${meta.symbol}:ref`).catch(() => null),
        ]);
        const out: PositionRow[] = [];
        if (real) {
          const r = toRow(meta, real, false);
          if (r) out.push(r);
        }
        if (paper) {
          const r = toRow(meta, paper, true);
          if (r) out.push(r);
        }
        return out;
      }),
    );
    const all = settled.flat();
    const open = all.filter(
      (r) => r.state === "entered" || r.state === "added" || r.state === "scaled",
    );

    // The cluster warning matters more here than on the board: this is the
    // page where the reader is looking at what they are actually carrying.
    const cluster = usdExposure(
      open
        .filter((r) => !r.paper)
        .map((r) => ({ symbol: r.symbol, stance: "enter" as const, direction: r.direction })),
    );

    // Today's shortlist, for the "下方今日推薦" band: entries the rules are
    // currently offering that are not already being held.
    const { rows: latest } = await readLatest(store);
    const held = new Set(open.filter((r) => !r.paper).map((r) => r.symbol));
    const candidates = latest
      .filter((s) => s?.trade_plan?.stance === "enter" && !held.has(s.symbol))
      .map((s) => ({
        symbol: s.symbol,
        direction: s.direction,
        grade: s.grade,
        entry: s.trade_plan?.entry ?? null,
        stopLoss: s.trade_plan?.stop_loss ?? null,
        takeProfit: s.trade_plan?.take_profit ?? null,
        riskReward: s.trade_plan?.risk_reward ?? null,
      }));

    return json({ open, resolved: all.filter((r) => !open.includes(r)), cluster, candidates });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : String(err), rows: [] },
      { status: 500 },
    );
  }
}

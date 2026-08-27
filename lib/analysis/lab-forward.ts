import type { Candle } from "../data-sources/ohlcv";
import { COMMODITIES, type CommodityMeta } from "@/types/signal";
import type { LabTradeRow, LabTradeStatus } from "../db";
import { CONDITIONS, WARMUP, buildContext, type LabContext } from "./lab";
import { MANAGE_HORIZON, SCALE_OUT_FRACTION, registerLevels, walkManaged } from "./lab-manage";
import { totalCostFraction, tradingCostFor } from "@/config/trading-costs";

/**
 * 前進實驗 — every condition trading on its own, forward, one bar at a time.
 *
 * ## What this measures that a backtest cannot
 *
 * The lab's backtest asks what a condition *would have done* on history that
 * already existed when the condition was written. The hold-out split removes
 * most of the self-deception in that, but not all of it: the twelve conditions
 * were chosen by people who had already looked at these markets, and no split
 * can undo that. This asks a cleaner question — what does the condition do on
 * bars nobody had seen when the trade was opened?
 *
 * Each row is a pre-registration. The entry, the initial stop and the target
 * are fixed at the close of the triggering bar, written to the database, and
 * never touched again; later sweeps may only resolve them. The *management*
 * — breakeven, trailing, the structure-flip exit — is code, not stored state:
 * the same deterministic rules replayed from the registered terms, so a
 * disappointing trade still cannot be reinterpreted after the fact.
 *
 * ## Independently, one at a time
 *
 * Every condition trades alone — that is the point of the exercise, and it is
 * also what makes the results comparable to the solo column of the backtest.
 * One open trade per (symbol, direction, condition): a condition that stays
 * true for thirty bars produces a sequence a person could actually have
 * traded, not thirty overlapping positions inflating the sample with what is
 * really one market move.
 *
 * ## The exits are the lab's, exactly
 *
 * Structural stop and overhead-pressure target registered at entry, then the
 * shared management rules (lib/analysis/lab-manage.ts): breakeven at 1R,
 * stop trailed behind new swings, exit on an opposite CHoCH, closed at the
 * market after the horizon. Anything else and the forward column would not be
 * comparable with the backtest column beside it, which is the whole reason to
 * show them together. A bar where a condition fires but no sane structural
 * stop exists opens nothing — the live plans refuse the same entry.
 */

export const FORWARD_HORIZON = MANAGE_HORIZON;

export function forwardTradeId(
  symbol: string,
  direction: "long" | "short",
  conditionId: string,
  entryBarTime: string,
): string {
  return `${symbol}:${direction}:${conditionId}:${entryBarTime}`;
}

/**
 * Opens whatever the newest bar triggers.
 *
 * Reads only the last completed bar — the same instant the backtest enters on
 * — and refuses to open anything the ledger already holds, whether open or
 * long since resolved. `existing` must therefore include both.
 */
export function openForwardTrades(
  meta: Pick<CommodityMeta, "symbol" | "category">,
  candles: Candle[],
  existing: LabTradeRow[],
  now: Date = new Date(),
  prebuilt?: LabContext,
): LabTradeRow[] {
  if (!candles || candles.length <= WARMUP + 1) return [];

  const i = candles.length - 1;
  const bar = candles[i];
  const ctx = prebuilt ?? buildContext(candles, [i]);
  const atr = ctx.atr[i];
  const entry = ctx.close[i];
  if (atr === null || !(atr > 0) || !(entry > 0)) return [];

  const openKeys = new Set(
    existing
      .filter((t) => t.status === "open")
      .map((t) => `${t.direction}:${t.conditionId}`),
  );
  const seenIds = new Set(existing.map((t) => t.id));

  const opened: LabTradeRow[] = [];
  for (const direction of ["long", "short"] as const) {
    // 結構化進出場：這個方向在這根 K 棒上若掛不出合理的結構停損，任何
    // 條件都開不了單 —— 和回測、和 live 計畫拒絕的是同一種進場。
    const levels = registerLevels(ctx, i, direction);
    if (!levels) continue;
    for (const condition of CONDITIONS) {
      const key = `${direction}:${condition.id}`;
      if (openKeys.has(key)) continue;
      const id = forwardTradeId(meta.symbol, direction, condition.id, bar.time);
      // Already opened on this bar by an earlier sweep — and already resolved
      // trades count too, or a re-run would reopen finished history.
      if (seenIds.has(id)) continue;

      let fires = false;
      try {
        fires = condition.test(ctx, i, direction);
      } catch {
        fires = false;
      }
      if (!fires) continue;

      opened.push({
        id,
        symbol: meta.symbol,
        direction,
        conditionId: condition.id,
        entryBarTime: bar.time,
        entry,
        stop: levels.stop,
        // The raw pressure level; costs are charged against the exit in R,
        // uniformly across every exit kind, rather than padded into one.
        target: levels.target,
        atr,
        horizonBars: FORWARD_HORIZON,
        status: "open",
        exitPrice: null,
        exitBarTime: null,
        barsHeld: null,
        openedAt: now.toISOString(),
        closedAt: null,
      });
      openKeys.add(key);
    }
  }
  return opened;
}

/**
 * Resolves an open trade by replaying the shared management rules over the
 * bars that printed after it.
 *
 * Matched by time rather than by index: a provider switch or a revised series
 * can renumber the bars, and a trade must not be lost because its entry bar
 * moved. The walk itself is walkManaged — the identical pessimistic ordering
 * the backtest uses — with the registered terms from the row and the entry
 * ATR stored at open. A trade closed at the horizon is closed at the market:
 * a real result, classified by the sign of its net R like every other exit.
 *
 * Returns null while the trade is still legitimately open.
 */
export function resolveForwardTrade(
  trade: LabTradeRow,
  candles: Candle[],
  ctx?: LabContext,
  costFraction = 0,
  now: Date = new Date(),
): LabTradeRow | null {
  const context = ctx ?? buildContext(candles, []);
  let firstBar = -1;
  for (let k = 0; k < candles.length; k++) {
    if (candles[k].time > trade.entryBarTime) {
      firstBar = k;
      break;
    }
  }
  if (firstBar < 0) return null;

  const exit = walkManaged({
    ctx: context,
    direction: trade.direction,
    firstBar,
    entry: trade.entry,
    stop: trade.stop,
    target: trade.target,
    entryAtr: trade.atr,
    horizon: trade.horizonBars,
    costFraction,
  });
  if (!exit) return null;

  const status: LabTradeStatus = exit.r > 0 ? "win" : "loss";
  // 分批止盈 makes one trade exit at two prices. The ledger stores a single
  // exit_price, so a scaled trade records its volume-weighted average exit —
  // with SCALE_OUT_FRACTION at one half that is the plain midpoint, and it
  // reproduces the blended R exactly when rowR reconstructs it from prices.
  const exitPrice = exit.scaleOut
    ? SCALE_OUT_FRACTION * exit.scaleOut.price + (1 - SCALE_OUT_FRACTION) * exit.exitPrice
    : exit.exitPrice;
  return {
    ...trade,
    status,
    exitPrice,
    exitBarTime: candles[exit.exitIndex].time,
    barsHeld: exit.exitIndex - firstBar + 1,
    closedAt: now.toISOString(),
  };
}

export interface ForwardStat {
  conditionId: string;
  label: string;
  direction: "long" | "short";
  open: number;
  wins: number;
  losses: number;
  /** Legacy rows resolved as 到期 under the old fixed geometry. */
  expired: number;
  /** Resolved trades — wins + losses. Legacy expiries are excluded. */
  resolved: number;
  hitRate: number | null;
  /** Mean R per resolved trade, net of costs — the number that decides. */
  expectancyR: number | null;
  /** Every trade ever opened for this condition, in any state. */
  taken: number;
}

/** Net R of one resolved row, using the same cost model the resolver charged. */
function rowR(r: LabTradeRow): number | null {
  if (r.exitPrice === null) return null;
  const risk0 = Math.abs(r.entry - r.stop);
  if (!(risk0 > 0)) return null;
  const meta = COMMODITIES.find((c) => c.symbol === r.symbol);
  const costFraction = meta
    ? totalCostFraction(tradingCostFor(meta.category), r.horizonBars / 2)
    : 0;
  const gross = r.direction === "long" ? r.exitPrice - r.entry : r.entry - r.exitPrice;
  return (gross - r.entry * costFraction) / risk0;
}

/** Per condition and direction, newest data included. Sorted by expectancy. */
export function summariseForward(rows: LabTradeRow[]): ForwardStat[] {
  const byKey = new Map<string, ForwardStat & { rSum: number; rCount: number }>();
  for (const r of rows) {
    const key = `${r.direction}:${r.conditionId}`;
    let stat = byKey.get(key);
    if (!stat) {
      stat = {
        conditionId: r.conditionId,
        label: CONDITIONS.find((c) => c.id === r.conditionId)?.label ?? r.conditionId,
        direction: r.direction,
        open: 0,
        wins: 0,
        losses: 0,
        expired: 0,
        resolved: 0,
        hitRate: null,
        expectancyR: null,
        taken: 0,
        rSum: 0,
        rCount: 0,
      };
      byKey.set(key, stat);
    }
    stat.taken++;
    if (r.status === "open") stat.open++;
    else if (r.status === "win") stat.wins++;
    else if (r.status === "loss") stat.losses++;
    else stat.expired++;
    if (r.status === "win" || r.status === "loss") {
      const netR = rowR(r);
      if (netR !== null) {
        stat.rSum += netR;
        stat.rCount++;
      }
    }
  }
  const stats = [...byKey.values()];
  for (const s of stats) {
    s.resolved = s.wins + s.losses;
    s.hitRate = s.resolved > 0 ? Math.round((s.wins / s.resolved) * 1000) / 1000 : null;
    s.expectancyR = s.rCount > 0 ? Math.round((s.rSum / s.rCount) * 100) / 100 : null;
  }
  return stats
    .map((s) => {
      const { rSum, rCount, ...rest } = s;
      void rSum;
      void rCount;
      return rest;
    })
    .sort(
      (a, b) =>
        (b.expectancyR ?? -999) - (a.expectancyR ?? -999) || b.resolved - a.resolved,
    );
}

/**
 * One sweep of the ledger for one symbol: resolve what the new bars settled,
 * then open what the newest bar triggers.
 *
 * Resolution comes first on purpose. A condition whose trade closes on this
 * very bar is free to open its next one immediately — waiting a bar would be
 * an arbitrary handicap the backtest does not apply.
 */
export function advanceForward(
  meta: Pick<CommodityMeta, "symbol" | "category">,
  candles: Candle[],
  existing: LabTradeRow[],
  now: Date = new Date(),
): { resolved: LabTradeRow[]; opened: LabTradeRow[] } {
  // One context for the whole sweep: the resolver needs the swing and CHoCH
  // series over every bar, and the opener needs the newest bar's ATR.
  const ctx = buildContext(candles, [candles.length - 1]);
  const costFraction = totalCostFraction(tradingCostFor(meta.category), FORWARD_HORIZON / 2);

  const resolved: LabTradeRow[] = [];
  const stillOpen: LabTradeRow[] = [];
  for (const trade of existing) {
    if (trade.status !== "open") continue;
    const done = resolveForwardTrade(trade, candles, ctx, costFraction, now);
    if (done) resolved.push(done);
    else stillOpen.push(trade);
  }

  // The ledger as it stands after resolution: closed trades no longer block a
  // new entry, but their ids still do, so a bar cannot be traded twice.
  const after = [
    ...existing.filter((t) => t.status !== "open"),
    ...resolved.map((t) => ({ ...t })),
    ...stillOpen,
  ];
  return { resolved, opened: openForwardTrades(meta, candles, after, now, ctx) };
}

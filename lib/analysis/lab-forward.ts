import type { Candle } from "../data-sources/ohlcv";
import type { CommodityMeta } from "@/types/signal";
import type { LabTradeRow, LabTradeStatus } from "../db";
import { CONDITIONS, WARMUP, buildContext } from "./lab";
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
 * Each row is a pre-registration. The entry, the stop and the target are fixed
 * at the close of the triggering bar, written to the database, and never
 * touched again; later sweeps may only resolve them. There is no version of
 * this ledger in which a disappointing trade can be reinterpreted, because by
 * the time the outcome is knowable the terms are already stored.
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
 * ## The geometry is the lab's, exactly
 *
 * 1×ATR stop, 1.5×ATR target, 20-bar horizon, target cleared of the round-trip
 * cost. Anything else and the forward column would not be comparable with the
 * backtest column beside it, which is the whole reason to show them together.
 */

export const FORWARD_STOP_ATR = 1;
export const FORWARD_TARGET_ATR = 1.5;
export const FORWARD_HORIZON = 20;

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
): LabTradeRow[] {
  if (!candles || candles.length <= WARMUP + 1) return [];

  const i = candles.length - 1;
  const bar = candles[i];
  const ctx = buildContext(candles, [i]);
  const atr = ctx.atr[i];
  const entry = ctx.close[i];
  if (atr === null || !(atr > 0) || !(entry > 0)) return [];

  const cost = tradingCostFor(meta.category);
  const costFraction = totalCostFraction(cost, FORWARD_HORIZON / 2);
  const openKeys = new Set(
    existing
      .filter((t) => t.status === "open")
      .map((t) => `${t.direction}:${t.conditionId}`),
  );
  const seenIds = new Set(existing.map((t) => t.id));

  const opened: LabTradeRow[] = [];
  for (const direction of ["long", "short"] as const) {
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

      const stopDist = atr * FORWARD_STOP_ATR;
      const targetDist = atr * FORWARD_TARGET_ATR;
      const costAmount = entry * costFraction;
      opened.push({
        id,
        symbol: meta.symbol,
        direction,
        conditionId: condition.id,
        entryBarTime: bar.time,
        entry,
        stop: direction === "long" ? entry - stopDist : entry + stopDist,
        // The target clears the round trip before it counts as a win — the
        // same rule the backtest applies, for the same reason.
        target:
          direction === "long"
            ? entry + targetDist + costAmount
            : entry - targetDist - costAmount,
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
 * Resolves an open trade against the bars that printed after it.
 *
 * Matched by time rather than by index: a provider switch or a revised series
 * can renumber the bars, and a trade must not be lost because its entry bar
 * moved. Both levels touched in one bar counts as a loss — daily bars cannot
 * order intrabar events, and the pessimistic read is the only honest one.
 *
 * Returns null while the trade is still legitimately open.
 */
export function resolveForwardTrade(
  trade: LabTradeRow,
  candles: Candle[],
  now: Date = new Date(),
): LabTradeRow | null {
  const after = candles
    .filter((c) => c.time > trade.entryBarTime)
    .slice(0, trade.horizonBars);
  if (after.length === 0) return null;

  const close = (status: LabTradeStatus, bar: Candle, price: number, held: number): LabTradeRow => ({
    ...trade,
    status,
    exitPrice: price,
    exitBarTime: bar.time,
    barsHeld: held,
    closedAt: now.toISOString(),
  });

  for (let k = 0; k < after.length; k++) {
    const bar = after[k];
    const hitStop = trade.direction === "long" ? bar.low <= trade.stop : bar.high >= trade.stop;
    const hitTarget =
      trade.direction === "long" ? bar.high >= trade.target : bar.low <= trade.target;
    if (hitStop) return close("loss", bar, trade.stop, k + 1);
    if (hitTarget) return close("win", bar, trade.target, k + 1);
  }

  // Out of time, still alive: an expiry is not a loss and must never be
  // counted as one — but it is not a win either, and burying it would make the
  // hit rate a statement about a self-selected subset.
  if (after.length >= trade.horizonBars) {
    const last = after[after.length - 1];
    return close("expired", last, last.close, after.length);
  }
  return null;
}

export interface ForwardStat {
  conditionId: string;
  label: string;
  direction: "long" | "short";
  open: number;
  wins: number;
  losses: number;
  expired: number;
  /** Resolved trades — wins + losses. Expiries are excluded, as in the backtest. */
  resolved: number;
  hitRate: number | null;
  /** Every trade ever opened for this condition, in any state. */
  taken: number;
}

/** Per condition and direction, newest data included. Sorted by hit rate. */
export function summariseForward(rows: LabTradeRow[]): ForwardStat[] {
  const byKey = new Map<string, ForwardStat>();
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
        taken: 0,
      };
      byKey.set(key, stat);
    }
    stat.taken++;
    if (r.status === "open") stat.open++;
    else if (r.status === "win") stat.wins++;
    else if (r.status === "loss") stat.losses++;
    else stat.expired++;
  }
  const stats = [...byKey.values()];
  for (const s of stats) {
    s.resolved = s.wins + s.losses;
    s.hitRate = s.resolved > 0 ? Math.round((s.wins / s.resolved) * 1000) / 1000 : null;
  }
  return stats.sort(
    (a, b) => (b.hitRate ?? -1) - (a.hitRate ?? -1) || b.resolved - a.resolved,
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
  const resolved: LabTradeRow[] = [];
  const stillOpen: LabTradeRow[] = [];
  for (const trade of existing) {
    if (trade.status !== "open") continue;
    const done = resolveForwardTrade(trade, candles, now);
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
  return { resolved, opened: openForwardTrades(meta, candles, after, now) };
}

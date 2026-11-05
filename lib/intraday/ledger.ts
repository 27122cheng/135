import type { Candle } from "../data-sources/ohlcv";
import type { LabTradeRow } from "../db";
import { forwardTradeId, resolveForwardTrade } from "../analysis/lab-forward";
import { totalCostFraction, tradingCostFor } from "@/config/trading-costs";
import { wilson } from "../journal/performance";
import { INTRADAY_HORIZON, type IntradaySignal } from "./engine";

/**
 * 日內紙上帳本 — every intraday entry is paper-traded in the lab ledger
 * under its own condition id, resolved by the same managed walk the H4
 * engine and the lab use. Nothing reaches Telegram until this ledger has
 * PROVE_MIN resolved trades with positive expectancy — the point of the
 * mode is to find out, not to assume.
 */

export const INTRADAY_CONDITION = "intraday:m15-pullback";
export const PROVE_MIN = 20;

export function isIntradayRow(row: LabTradeRow): boolean {
  return row.conditionId === INTRADAY_CONDITION;
}

/** One open paper trade per symbol; one per bar ever. */
export function openIntradayTrade(signal: IntradaySignal, existing: LabTradeRow[], now = new Date()): LabTradeRow | null {
  if (signal.stance !== "enter" || signal.direction === null || signal.entry === null || signal.stop === null || signal.atr15 === null) return null;
  if (existing.some((t) => isIntradayRow(t) && t.symbol === signal.symbol && t.status === "open")) return null;
  const id = forwardTradeId(signal.symbol, signal.direction, INTRADAY_CONDITION, signal.barTime);
  if (existing.some((t) => t.id === id)) return null;
  return {
    id,
    symbol: signal.symbol,
    direction: signal.direction,
    conditionId: INTRADAY_CONDITION,
    entryBarTime: signal.barTime,
    entry: signal.entry,
    stop: signal.stop,
    target: signal.target,
    atr: signal.atr15,
    horizonBars: INTRADAY_HORIZON,
    status: "open",
    exitPrice: null,
    exitBarTime: null,
    barsHeld: null,
    openedAt: now.toISOString(),
    closedAt: null,
  };
}

export function resolveIntradayTrades(open: LabTradeRow[], m15: Candle[], now = new Date()): LabTradeRow[] {
  const costFraction = totalCostFraction(tradingCostFor("crypto"), INTRADAY_HORIZON / 2);
  const out: LabTradeRow[] = [];
  for (const t of open) {
    if (!isIntradayRow(t) || t.status !== "open") continue;
    const done = resolveForwardTrade(t, m15, undefined, costFraction, now);
    if (done) out.push(done);
  }
  return out;
}

export interface IntradayStats {
  open: number;
  resolved: number;
  wins: number;
  losses: number;
  winRate: number | null;
  winRateLow: number | null;
  winRateHigh: number | null;
  expectancyR: number | null;
  /** Ready to notify: resolved ≥ PROVE_MIN and expectancy > 0. */
  proven: boolean;
  note: string;
}

export function intradayStats(rows: LabTradeRow[]): IntradayStats {
  const mine = rows.filter(isIntradayRow);
  const open = mine.filter((t) => t.status === "open").length;
  const done = mine.filter((t) => t.status === "win" || t.status === "loss");
  const costFraction = totalCostFraction(tradingCostFor("crypto"), INTRADAY_HORIZON / 2);
  const rs = done
    .map((t) => {
      if (t.exitPrice === null) return null;
      const risk = Math.abs(t.entry - t.stop);
      if (!(risk > 0)) return null;
      const gross = t.direction === "long" ? t.exitPrice - t.entry : t.entry - t.exitPrice;
      return (gross - t.entry * costFraction) / risk;
    })
    .filter((x): x is number => x !== null);
  const wins = rs.filter((x) => x > 0.1).length;
  const losses = rs.filter((x) => x < -0.1).length;
  const wr = wilson(wins, losses);
  const expectancyR = rs.length > 0 ? Math.round((rs.reduce((a, b) => a + b, 0) / rs.length) * 100) / 100 : null;
  const proven = rs.length >= PROVE_MIN && expectancyR !== null && expectancyR > 0;
  const note = proven
    ? `已驗證：${rs.length} 筆，期望值 ${expectancyR}R，可開啟通知`
    : rs.length === 0
      ? `紙上追蹤中，尚無結算（滿 ${PROVE_MIN} 筆且期望值 > 0 才會通知）`
      : `紙上追蹤 ${rs.length}/${PROVE_MIN} 筆，期望值 ${expectancyR}R${expectancyR !== null && expectancyR <= 0 ? "（目前為負，不會通知）" : ""}`;
  return { open, resolved: rs.length, wins, losses, winRate: wr.rate, winRateLow: wr.low, winRateHigh: wr.high, expectancyR, proven, note };
}

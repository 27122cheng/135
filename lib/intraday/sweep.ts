import type { SignalStore, LabTradeRow } from "@/lib/db";
import { allInstruments } from "@/lib/server-symbols";
import { binanceSymbolFor, fetchBinanceIntraday } from "@/lib/data-sources/binance-crypto";
import { analyzeIntraday, type IntradaySignal } from "./engine";
import { intradayStats, isIntradayRow, openIntradayTrade, resolveIntradayTrades, type IntradayStats } from "./ledger";

/**
 * 日內掃描 — the crypto roster: built-in majors plus any user-added crypto.
 * Signals are computed every call; the paper ledger needs a store.
 */

export const DEFAULT_CRYPTO = [
  { symbol: "BTCUSD", label: "比特幣", pair: "BTCUSDT" },
  { symbol: "ETHUSD", label: "以太幣", pair: "ETHUSDT" },
  { symbol: "SOLUSD", label: "Solana", pair: "SOLUSDT" },
];

export interface IntradayRosterEntry {
  symbol: string;
  label: string;
  pair: string;
}

export async function intradayRoster(): Promise<IntradayRosterEntry[]> {
  const roster = await allInstruments().catch(() => []);
  const customs = roster
    .filter((m) => m.category === "crypto")
    .map((m) => ({ symbol: m.symbol, label: m.label, pair: binanceSymbolFor(m.yfinanceSymbol) }))
    .filter((m): m is IntradayRosterEntry => m.pair !== null);
  const seen = new Set(customs.map((c) => c.pair));
  return [...customs, ...DEFAULT_CRYPTO.filter((d) => !seen.has(d.pair))];
}

export interface IntradaySweepResult {
  ranAt: string;
  signals: Array<IntradaySignal & { label: string; gaps: string[]; openTrade: LabTradeRow | null }>;
  stats: IntradayStats | null;
  recent: LabTradeRow[];
  ledger: "store" | "none";
  opened: number;
  resolved: number;
}

export async function runIntradaySweep(store: SignalStore | null, now = new Date()): Promise<IntradaySweepResult> {
  const roster = await intradayRoster();
  const existing: LabTradeRow[] = store
    ? (await store.listLabTrades({ limit: 2000 }).catch(() => [] as LabTradeRow[])).filter(isIntradayRow)
    : [];
  let opened = 0;
  let resolved = 0;
  const signals: IntradaySweepResult["signals"] = [];
  for (const entry of roster) {
    const gaps: string[] = [];
    const [h1, m15] = await Promise.all([
      fetchBinanceIntraday(entry.pair, "1h", gaps, 300),
      fetchBinanceIntraday(entry.pair, "15m", gaps, 400),
    ]);
    const signal = analyzeIntraday({ symbol: entry.symbol, pair: entry.pair, h1, m15 });
    let openTrade: LabTradeRow | null = null;
    if (store && m15) {
      const mine = existing.filter((t) => t.symbol === entry.symbol);
      const done = resolveIntradayTrades(mine.filter((t) => t.status === "open"), m15, now);
      if (done.length > 0) {
        await store.resolveLabTrades(done).catch(() => 0);
        resolved += done.length;
        for (const d of done) {
          const i = existing.findIndex((t) => t.id === d.id);
          if (i >= 0) existing[i] = d;
        }
      }
      const fresh = openIntradayTrade(signal, existing, now);
      if (fresh) {
        const n = await store.insertLabTrades([fresh]).catch(() => 0);
        if (n > 0) {
          existing.push(fresh);
          opened++;
        }
      }
      openTrade = existing.find((t) => t.symbol === entry.symbol && t.status === "open") ?? null;
    }
    signals.push({ ...signal, label: entry.label, gaps, openTrade });
  }
  const recent = [...existing].sort((a, b) => (b.closedAt ?? b.openedAt).localeCompare(a.closedAt ?? a.openedAt)).slice(0, 20);
  return {
    ranAt: now.toISOString(),
    signals,
    stats: store ? intradayStats(existing) : null,
    recent,
    ledger: store ? "store" : "none",
    opened,
    resolved,
  };
}

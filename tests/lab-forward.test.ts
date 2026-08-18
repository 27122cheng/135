import { check, report } from "./_harness";
import {
  advanceForward,
  forwardTradeId,
  openForwardTrades,
  resolveForwardTrade,
  summariseForward,
  FORWARD_HORIZON,
} from "@/lib/analysis/lab-forward";
import { WARMUP } from "@/lib/analysis/lab";
import type { Candle } from "@/lib/data-sources/ohlcv";
import type { LabTradeRow } from "@/lib/db";

/**
 * 前進實驗.
 *
 * The ledger's value rests entirely on properties that must hold every time,
 * not on any particular result: a trade is registered before its outcome
 * exists, the same bar cannot be traded twice, a condition never holds two
 * open positions at once, and a trade that reached neither level is recorded
 * as expired rather than quietly counted as a win or dropped.
 */

function bars(fn: (i: number) => number, n: number, from = 0): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const c = fn(i);
    out.push({
      time: new Date(Date.UTC(2020, 0, 1 + from + i)).toISOString(),
      open: c,
      high: c * 1.006,
      low: c * 0.994,
      close: c,
      volume: 1000,
    });
  }
  return out;
}

const meta = { symbol: "XAUUSD", category: "metal" as const };

// ── opening ───────────────────────────────────────────────────────
{
  const up = bars((i) => 100 * 1.004 ** i, 200);
  const opened = openForwardTrades(meta, up, []);
  check("an uptrend opens trades", opened.length > 0, opened.length);
  check("every trade names one condition and one direction",
    opened.every((t) => t.conditionId.length > 0 && (t.direction === "long" || t.direction === "short")));
  check("all of them enter at the newest bar's close",
    opened.every((t) => t.entry === up[up.length - 1].close && t.entryBarTime === up[up.length - 1].time));
  check("and are open, with nothing filled in yet",
    opened.every((t) => t.status === "open" && t.exitPrice === null && t.barsHeld === null));

  // The geometry is the lab's, or the two columns are not comparable.
  const long = opened.find((t) => t.direction === "long")!;
  check("the stop sits 1×ATR the wrong side of entry",
    Math.abs(long.entry - long.stop - long.atr) < 1e-9, { entry: long.entry, stop: long.stop, atr: long.atr });
  check("and the target beyond 1.5×ATR, cost included",
    long.target > long.entry + long.atr * 1.5, { target: long.target, atr: long.atr });

  check("no condition opens twice on one bar",
    new Set(opened.map((t) => `${t.direction}:${t.conditionId}`)).size === opened.length);

  // Idempotence: the same bar, run again, must add nothing.
  check("re-running on the same bar opens nothing",
    openForwardTrades(meta, up, opened).length === 0);

  // One open position per condition, even on a later bar.
  const next = [...up, ...bars((i) => 100 * 1.004 ** (200 + i), 1, 200)];
  check("a condition already holding a position does not open another",
    openForwardTrades(meta, next, opened).every(
      (t) => !opened.some((o) => o.direction === t.direction && o.conditionId === t.conditionId)),
    openForwardTrades(meta, next, opened).map((t) => t.conditionId));

  check("too little history opens nothing",
    openForwardTrades(meta, bars((i) => 100 + i, WARMUP), []).length === 0);

  // The id is what makes the whole ledger idempotent.
  check("the id is derived from symbol, direction, condition and entry bar",
    long.id === forwardTradeId("XAUUSD", "long", long.conditionId, long.entryBarTime), long.id);
}

// ── resolving ─────────────────────────────────────────────────────
{
  const base: LabTradeRow = {
    id: "X:long:c:2020-01-01T00:00:00.000Z",
    symbol: "XAUUSD",
    direction: "long",
    conditionId: "ema50-side",
    entryBarTime: "2020-01-01T00:00:00.000Z",
    entry: 100,
    stop: 98,
    target: 103,
    atr: 2,
    horizonBars: FORWARD_HORIZON,
    status: "open",
    exitPrice: null,
    exitBarTime: null,
    barsHeld: null,
    openedAt: "2020-01-01T00:00:00.000Z",
    closedAt: null,
  };
  // Day 0 is the first bar *after* the entry bar — a bar at the entry's own
  // timestamp is not a later bar and must never resolve it.
  const at = (day: number, high: number, low: number): Candle => ({
    time: new Date(Date.UTC(2020, 0, 2 + day)).toISOString(),
    open: 100, high, low, close: (high + low) / 2, volume: 1,
  });

  const won = resolveForwardTrade(base, [at(0, 101, 99), at(1, 101, 99), at(2, 104, 100)])!;
  check("a target hit is a win", won.status === "win", won);
  check("recorded at the target price and the bar that reached it",
    won.exitPrice === 103 && won.barsHeld === 3, won);

  const lost = resolveForwardTrade(base, [at(0, 101, 99), at(1, 100, 97)])!;
  check("a stop hit is a loss", lost.status === "loss" && lost.barsHeld === 2, lost);

  // Daily bars cannot order intrabar events, so both in one bar is a loss.
  const both = resolveForwardTrade(base, [at(0, 104, 97)])!;
  check("both levels in one bar counts as a loss", both.status === "loss", both);

  const still = resolveForwardTrade(base, [at(0, 101, 99), at(1, 101, 99)]);
  check("a trade that reached neither level stays open", still === null);

  const flat = Array.from({ length: FORWARD_HORIZON }, (_, k) => at(k, 101, 99));
  const timedOut = resolveForwardTrade(base, flat)!;
  check("out of time is 逾時, not a loss", timedOut.status === "expired", timedOut);
  check("and exits at the last bar's close, not at a level",
    timedOut.exitPrice === flat[flat.length - 1].close, timedOut);

  // Bars before the entry must never resolve it — the one bug that would turn
  // this ledger into a lie.
  const before: Candle[] = [
    { time: "2019-12-30T00:00:00.000Z", open: 100, high: 200, low: 1, close: 100, volume: 1 },
    { time: "2019-12-31T00:00:00.000Z", open: 100, high: 200, low: 1, close: 100, volume: 1 },
  ];
  check("bars before the entry cannot resolve a trade",
    resolveForwardTrade(base, before) === null);

  const short = { ...base, direction: "short" as const, stop: 102, target: 97 };
  check("a short resolves the other way up",
    resolveForwardTrade(short, [at(0, 101, 96)])!.status === "win");
  check("and stops out on a rise",
    resolveForwardTrade(short, [at(0, 103, 99)])!.status === "loss");
}

// ── one full advance ──────────────────────────────────────────────
{
  const series = bars((i) => 100 * 1.004 ** i, 200);
  const first = advanceForward(meta, series, []);
  check("the first advance opens without resolving anything",
    first.opened.length > 0 && first.resolved.length === 0);

  // Twenty more bars: everything either resolved or is legitimately still open.
  const later = [...series, ...bars((i) => 100 * 1.004 ** (200 + i), 25, 200)];
  const second = advanceForward(meta, later, first.opened);
  check("a later advance resolves the trades the new bars settled",
    second.resolved.length > 0, second.resolved.length);
  check("nothing is resolved twice",
    second.resolved.every((t) => t.status !== "open"));
  check("and a resolved condition is free to open again",
    second.opened.length > 0, second.opened.map((t) => t.conditionId));

  // Running the same advance again must be a no-op on the same bar.
  const ledger = [...first.opened.map((t) => second.resolved.find((r) => r.id === t.id) ?? t), ...second.opened];
  const third = advanceForward(meta, later, ledger);
  check("re-running the advance on the same bar changes nothing",
    third.opened.length === 0 && third.resolved.length === 0,
    { opened: third.opened.length, resolved: third.resolved.length });
}

// ── the summary counts what it says it counts ─────────────────────
{
  const row = (over: Partial<LabTradeRow>): LabTradeRow => ({
    id: Math.random().toString(36),
    symbol: "XAUUSD",
    direction: "long",
    conditionId: "ema50-side",
    entryBarTime: "2020-01-01T00:00:00.000Z",
    entry: 100, stop: 98, target: 103, atr: 2,
    horizonBars: 20,
    status: "win",
    exitPrice: 103, exitBarTime: null, barsHeld: 3,
    openedAt: "2020-01-01T00:00:00.000Z", closedAt: null,
    ...over,
  });
  const stats = summariseForward([
    row({ status: "win" }), row({ status: "win" }), row({ status: "win" }),
    row({ status: "loss" }),
    row({ status: "expired" }),
    row({ status: "open" }),
    row({ status: "win", direction: "short" }),
  ]);
  const long = stats.find((s) => s.direction === "long")!;
  check("wins, losses, expiries and open trades are counted separately",
    long.wins === 3 && long.losses === 1 && long.expired === 1 && long.open === 1, long);
  check("the hit rate is over resolved trades only", long.hitRate === 0.75, long.hitRate);
  check("but every trade ever taken is still reported", long.taken === 6, long.taken);
  check("directions are kept apart", stats.length === 2, stats.map((s) => s.direction));
  check("a condition with nothing resolved reports no hit rate",
    summariseForward([row({ status: "open" })])[0].hitRate === null);
}

report("前進實驗");

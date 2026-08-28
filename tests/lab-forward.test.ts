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
import { classifyR } from "@/lib/analysis/lab-manage";
import type { Candle } from "@/lib/data-sources/ohlcv";
import type { LabTradeRow } from "@/lib/db";

/**
 * 前進實驗.
 *
 * The ledger's value rests entirely on properties that must hold every time,
 * not on any particular result: a trade is registered before its outcome
 * exists, the same bar cannot be traded twice, a condition never holds two
 * open positions at once, and every closed trade carries a real exit — the
 * managed walk (structural stop, breakeven, trailing, CHoCH exit, horizon
 * close at the market) classifies it by the sign of its net R.
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
  // The series needs real pullbacks: stops hang off confirmed swings now, and
  // a strictly monotonic series never confirms a pivot.
  const wave = (i: number) => 100 * 1.004 ** i * (1 + 0.012 * Math.sin(i / 4));
  const up = bars(wave, 200);
  const opened = openForwardTrades(meta, up, []);
  check("a trending series with pullbacks opens trades", opened.length > 0, opened.length);
  check("every trade names one condition and one direction",
    opened.every((t) => t.conditionId.length > 0 && (t.direction === "long" || t.direction === "short")));
  check("all of them enter at the newest bar's close",
    opened.every((t) => t.entry === up[up.length - 1].close && t.entryBarTime === up[up.length - 1].time));
  check("and are open, with nothing filled in yet",
    opened.every((t) => t.status === "open" && t.exitPrice === null && t.barsHeld === null));

  // The levels are structural, screened the same way the live plans screen.
  check("every stop sits on the losing side, outside the noise and near enough to protect",
    opened.every((t) => {
      const dist = t.direction === "long" ? t.entry - t.stop : t.stop - t.entry;
      return dist >= t.atr * 0.6 - 1e-9 && dist <= t.atr * 2.5 + 1e-9;
    }),
    opened.map((t) => (t.entry - t.stop) / t.atr));
  check("every registered target is real overhead pressure or absent",
    opened.every(
      (t) =>
        t.target === null ||
        (t.direction === "long" ? t.target > t.entry : t.target < t.entry),
    ),
    opened.map((t) => t.target));

  check("no condition opens twice on one bar",
    new Set(opened.map((t) => `${t.direction}:${t.conditionId}`)).size === opened.length);

  // Idempotence: the same bar, run again, must add nothing.
  check("re-running on the same bar opens nothing",
    openForwardTrades(meta, up, opened).length === 0);

  // One open position per condition, even on a later bar.
  const next = [...up, ...bars((i) => wave(200 + i), 1, 200)];
  check("a condition already holding a position does not open another",
    openForwardTrades(meta, next, opened).every(
      (t) => !opened.some((o) => o.direction === t.direction && o.conditionId === t.conditionId)),
    openForwardTrades(meta, next, opened).map((t) => t.conditionId));

  check("too little history opens nothing",
    openForwardTrades(meta, bars((i) => 100 + i, WARMUP), []).length === 0);

  // The id is what makes the whole ledger idempotent.
  const anyTrade = opened[0];
  check("the id is derived from symbol, direction, condition and entry bar",
    anyTrade.id ===
      forwardTradeId("XAUUSD", anyTrade.direction, anyTrade.conditionId, anyTrade.entryBarTime),
    anyTrade.id);
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

  // 分批止盈 needs a target worth ≥ SCALE_OUT_MIN_R (2R). base's target sits
  // 1.5R away — the typical day plan the floors admit — so the touch exits
  // the WHOLE position at the target: the second live sweep showed that
  // scaling out of 1.5R targets collapsed every measured expectancy to ≈0,
  // and the regime that historically measured +0.69R was full exit there.
  const won = resolveForwardTrade(base, [at(0, 101, 99), at(1, 101, 99), at(2, 104, 100)])!;
  check("a 1.5R target still exits in full", won.status === "win", won);
  check("recorded at the target price and the bar that reached it",
    won.exitPrice === 103 && won.barsHeld === 3, won);

  // A genuinely far target (105 on a 2-point risk = 2.5R) earns the split:
  // half banked, remainder rides at ≥ breakeven until stop/flip/horizon.
  const far = { ...base, target: 105 };
  check("a ≥2R target touch alone does not close the trade",
    resolveForwardTrade(far, [at(0, 101, 99), at(1, 105.5, 100)]) === null);
  const farWon = resolveForwardTrade(far, [
    at(0, 101, 99), at(1, 105.5, 100), at(2, 101, 100),
  ])!;
  check("the remainder stopping at breakeven closes the far-target trade as a win",
    farWon.status === "win", farWon);
  check("recorded at the volume-weighted exit — half at 105, half at the 100 breakeven stop",
    farWon.exitPrice === 102.5 && farWon.barsHeld === 3, farWon);

  // And a sub-1R shelf, same rule, even more so.
  const nearShelf = resolveForwardTrade(
    { ...base, target: 101 },
    [at(0, 101.5, 99.5)],
  )!;
  check("a sub-1R target exits the whole position at the shelf",
    nearShelf.status === "win" && nearShelf.exitPrice === 101, nearShelf);

  const lost = resolveForwardTrade(base, [at(0, 101, 99), at(1, 100, 97)])!;
  check("a stop hit is a loss", lost.status === "loss" && lost.barsHeld === 2, lost);

  // Daily bars cannot order intrabar events, so both in one bar is a loss.
  const both = resolveForwardTrade(base, [at(0, 104, 97)])!;
  check("both levels in one bar counts as a loss", both.status === "loss", both);

  const still = resolveForwardTrade(base, [at(0, 101, 99), at(1, 101, 99)]);
  check("a trade that reached neither level stays open", still === null);

  const flat = Array.from({ length: FORWARD_HORIZON }, (_, k) => at(k, 101, 99));
  const timedOut = resolveForwardTrade(base, flat)!;
  check("out of time closes at the market and classifies by its R",
    timedOut.status === "loss", timedOut);
  check("and exits at the last bar's close, not at a level",
    timedOut.exitPrice === flat[flat.length - 1].close, timedOut);

  // 保本移停: 1R in favour moves the stop to the entry, so the pullback
  // scratches at breakeven instead of riding back to −1R.
  const scratched = resolveForwardTrade(base, [at(0, 102.5, 99.5), at(1, 101, 99.9)])!;
  check("after 1R in favour a pullback exits at the entry, not the old stop",
    scratched.exitPrice === 100 && scratched.status === "loss", scratched);

  // Bars before the entry must never resolve it — the one bug that would turn
  // this ledger into a lie.
  const before: Candle[] = [
    { time: "2019-12-30T00:00:00.000Z", open: 100, high: 200, low: 1, close: 100, volume: 1 },
    { time: "2019-12-31T00:00:00.000Z", open: 100, high: 200, low: 1, close: 100, volume: 1 },
  ];
  check("bars before the entry cannot resolve a trade",
    resolveForwardTrade(base, before) === null);

  // Scratch accounting: the exits the management manufactures at ≈0R are
  // 平, not 敗 — in expectancy, out of the hit rate.
  check("net R classification has a scratch band",
    classifyR(0.5) === "win" && classifyR(-0.5) === "loss" &&
    classifyR(0.05) === "scratch" && classifyR(-0.1) === "scratch" &&
    classifyR(0.11) === "win");

  const short = { ...base, direction: "short" as const, stop: 102, target: 97 };
  check("a short's 1.5R target exits in full the other way up",
    resolveForwardTrade(short, [at(0, 101, 96)])!.status === "win");
  check("and stops out on a rise",
    resolveForwardTrade(short, [at(0, 103, 99)])!.status === "loss");
  check("a short's ≥2R target scales out and stays open",
    resolveForwardTrade({ ...short, target: 95 }, [at(0, 101, 94.5)]) === null);
}

// ── one full advance ──────────────────────────────────────────────
{
  const wave = (i: number) => 100 * 1.004 ** i * (1 + 0.012 * Math.sin(i / 4));
  const series = bars(wave, 200);
  const first = advanceForward(meta, series, []);
  check("the first advance opens without resolving anything",
    first.opened.length > 0 && first.resolved.length === 0);

  // Twenty-five more bars: everything either resolved or is still open.
  const later = [...series, ...bars((i) => wave(200 + i), 25, 200)];
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
  // Buckets are re-derived from each row's reconstructed net R (scratch
  // accounting), so the fixtures carry exit prices that mean what their
  // status says: 103 = target (+1.5R), 98 = stop (−1R), 100 = breakeven.
  const stats = summariseForward([
    row({ status: "win" }), row({ status: "win" }), row({ status: "win" }),
    row({ status: "loss", exitPrice: 98 }),
    row({ status: "expired" }),
    row({ status: "open" }),
    row({ status: "win", direction: "short", stop: 102, target: 97, exitPrice: 97 }),
  ]);
  const long = stats.find((s) => s.direction === "long")!;
  check("wins, losses, legacy expiries and open trades are counted separately",
    long.wins === 3 && long.losses === 1 && long.expired === 1 && long.open === 1, long);
  check("the hit rate is over resolved trades only", long.hitRate === 0.75, long.hitRate);
  check("and the expectancy is measured in R, net of costs",
    long.expectancyR !== null && long.expectancyR > 0, long.expectancyR);
  check("but every trade ever taken is still reported", long.taken === 6, long.taken);
  check("directions are kept apart", stats.length === 2, stats.map((s) => s.direction));
  check("a condition with nothing resolved reports no hit rate",
    summariseForward([row({ status: "open" })])[0].hitRate === null);

  // A breakeven wash (exit at the entry) is a scratch: counted, shown, and
  // excluded from the rate — a 敗 at ±0R was how live hit rates read 19%.
  const withScratch = summariseForward([
    row({ status: "win" }),
    row({ status: "loss", exitPrice: 98 }),
    row({ status: "loss", exitPrice: 100 }),
  ])[0];
  check("a breakeven exit lands in the scratch bucket",
    withScratch.scratches === 1 && withScratch.wins === 1 && withScratch.losses === 1,
    withScratch);
  check("and the hit rate is over decisive trades only",
    withScratch.hitRate === 0.5 && withScratch.resolved === 3, withScratch);
}

report("前進實驗");

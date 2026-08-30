import { check, report } from "./_harness";
import { backtestPlanGeometry } from "@/lib/analysis/backtest";

function bars(closes: number[], spreadPct = 0) {
  return closes.map((c, i) => ({
    time: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    open: c, high: c * (1 + spreadPct), low: c * (1 - spreadPct), close: c, volume: null,
  }));
}

// 1. Relentless uptrend: a long with TP above and SL below should almost always win.
const up = bars(Array.from({ length: 200 }, (_, i) => 100 + i));
const r1 = backtestPlanGeometry("long", 100, 99, 102, up)!;
console.log("uptrend long:", r1.wins, "W /", r1.losses, "L /", r1.timeouts, "T, hit", r1.hitRate);
check("uptrend long should nearly always hit TP", r1.hitRate !== null && r1.hitRate > 0.95);
check("expectancy should be positive", r1.expectancyR !== null && r1.expectancyR > 0);

// 2. Same series, short: TP below in an uptrend should almost always lose.
const r2 = backtestPlanGeometry("short", 100, 101, 98, up)!;
console.log("uptrend short:", r2.wins, "W /", r2.losses, "L, hit", r2.hitRate);
check("uptrend short should nearly always lose", r2.hitRate !== null && r2.hitRate < 0.05);

// 3. Flat series with zero range: no ATR, so the managed walk cannot simulate
// the trade the monitor would run — nothing is sampled, nothing is invented.
const flat = bars(Array.from({ length: 200 }, () => 100));
const r3 = backtestPlanGeometry("long", 100, 95, 105, flat)!;
console.log("flat:", r3.wins, "W /", r3.losses, "L, hitRate", r3.hitRate);
check("a rangeless series resolves nothing", r3.resolved === 0);
check("no resolved -> null stats", r3.hitRate === null && r3.expectancyR === null);

// 4. Bars wide enough to straddle both levels -> conservative loss + flag.
const wide = bars(Array.from({ length: 200 }, () => 100), 0.10);
const r4 = backtestPlanGeometry("long", 100, 98, 102, wide)!;
console.log("straddle:", r4.wins, "W /", r4.losses, "L, ambiguous:", r4.hadAmbiguousBars);
check("straddle must count as loss, not win", r4.hadAmbiguousBars && r4.wins === 0);

// 5. Too few candles -> null, not a fabricated stat.
check("insufficient data must return null", backtestPlanGeometry("long", 100, 99, 102, bars([100, 101, 102])) === null);

// ── 掛單等回踩，不是收盤追進 ──────────────────────────────────────
//
// Most plans this system writes are pullback limit orders («等回測 H4 前低
// 上緣»), and the walk used to enter at every qualifying bar's close — a
// market order, i.e. a materially different and worse trade. The live cost
// was visible: grade-A setups on GER40 and US30 had *every* geometry
// measured as losing money, so the statistical veto refused them all.
{
  // A market that never dips: a pullback order resting below each signal
  // bar never fills, and the honest answer is "this measured nothing",
  // not a market entry's numbers wearing a limit order's label.
  const climb = bars(Array.from({ length: 120 }, (_, i) => 100 + i * 0.5), 0.001);
  const refClimb = climb[climb.length - 1].close;
  const limitNeverFills = backtestPlanGeometry(
    "long",
    refClimb * 0.995, // 0.5% below the price the signal fired at
    refClimb * 0.985,
    refClimb * 1.02,
    climb,
  )!;
  check("a pullback order in a market that never dips fills nothing",
    limitNeverFills.resolved === 0, limitNeverFills.resolved);
  check("and the basis says so rather than implying a market entry",
    limitNeverFills.basis?.includes("回踩掛單") === true &&
      limitNeverFills.basis?.includes("未成交") === true,
    limitNeverFills.basis);

  // An oscillating market does offer the dip: the order fills, and it fills
  // at the limit — a better price than the close that triggered it.
  const swing = bars(
    Array.from({ length: 200 }, (_, i) => 100 + 4 * Math.sin(i / 2)),
    0.002,
  );
  const refSwing = swing[swing.length - 1].close;
  const fills = backtestPlanGeometry(
    "long",
    refSwing * 0.99,
    refSwing * 0.975,
    refSwing * 1.03,
    swing,
  )!;
  check("a pullback order does fill when the market dips", fills.resolved > 0, fills.resolved);
  check("and the basis reports the fill count honestly",
    fills.basis?.includes("筆成交") === true, fills.basis);

  // A market entry is still a market entry: the entry sits at the price the
  // signal fired at, so it fills on that bar's close and says so.
  const atMarket = backtestPlanGeometry("long", refSwing, refSwing * 0.975, refSwing * 1.03, swing)!;
  check("a 現價進場 plan is not simulated as a limit order",
    atMarket.basis?.includes("現價進場") === true, atMarket.basis);

  // The bound is the live screen's own: `isNearEntry` never admits a
  // structure further than PROXIMITY_ATR from the zone, so an entry beyond
  // that is a mismatch (a stale plan, a synthetic input) and is measured on
  // its relative geometry at the market rather than answered with silence.
  // Fixture 1 above is exactly that case — entry 100 against a series that
  // ends near 299 — and it still produces a full sample.
  check("an entry beyond the live proximity screen falls back to market entry",
    r1.resolved > 0 && r1.basis?.includes("現價進場") === true, r1.basis);
}

report("bt");

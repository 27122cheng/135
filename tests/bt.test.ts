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

report("bt");

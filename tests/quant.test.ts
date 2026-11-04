import { check, report } from "./_harness";
import { baseRate, EXTENSION_VOTE_ATR, quantItems, quantStats, withPlan } from "@/lib/analysis/quant";
import type { Candle } from "@/lib/data-sources/ohlcv";

/** 量化統計 — regime numbers beside the call, and the plan's base rate. */

function series(n: number, step: (i: number) => number, start = 100, range = 2): Candle[] {
  const out: Candle[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const next = p + step(i);
    out.push({ time: `2026-01-01T00:00:00.000Z`, open: p, high: Math.max(p, next) + range / 2, low: Math.min(p, next) - range / 2, close: next, volume: 1000 });
    p = next;
  }
  return out;
}

{
  // Alternating returns → negative autocorrelation (mean reversion).
  const zig = series(300, (i) => (i % 2 === 0 ? 1.5 : -1.5));
  const q = quantStats(zig, zig[zig.length - 1].close);
  check("stats exist", q !== null);
  check("alternating returns read as mean reversion", q?.autocorrLabel === "均值回歸", q?.autocorr1);
  check("expected move scales with √horizon", q !== null && Math.abs(q.expectedMove!.price - q.atr14 * Math.sqrt(5)) < 0.01, q?.expectedMove);
  check("no extension vote while hugging the mean", quantItems(q).every((i) => i.key !== "quant-extension"), quantItems(q));
  check("the regime line is a weight-0 item", quantItems(q).some((i) => i.key === "quant-regime" && i.weight === 0));
}

{
  // A straight run-up: positive autocorrelation is not guaranteed with constant steps, but the
  // extension past EMA20 is — the last bars jump.
  const run = series(300, (i) => (i > 290 ? 6 : 0.2));
  const q = quantStats(run, run[run.length - 1].close);
  check("a chase past EMA20 shows as extension", q !== null && (q.extensionAtr ?? 0) >= EXTENSION_VOTE_ATR, q?.extensionAtr);
  const items = quantItems(q);
  check("and votes against the chase", items.some((i) => i.key === "quant-extension" && i.direction === "short" && i.weight === 1), items);
  check("vol percentile is high after the jump", (q?.volPercentile ?? 0) >= 80, q?.volPercentile);
}

{
  // Base rate: tiny target, huge stop → target reached first nearly always.
  const flat = series(200, (i) => (i % 2 === 0 ? 1 : -1));
  const easy = baseRate(flat, "long", 0.5, 50, 5);
  check("an easy target has a base rate near 1", (easy.rate ?? 0) >= 0.95 && easy.samples > 100, easy);
  const hard = baseRate(flat, "long", 50, 0.5, 5);
  check("an impossible target has a base rate near 0", (hard.rate ?? 1) <= 0.05, hard);
  check("bad distances give no rate", baseRate(flat, "long", 0, 1, 5).rate === null);

  const q = withPlan(quantStats(flat, 100), flat, "long", { entry: 100, stop_loss: 99.5, take_profit: 150 });
  check("the plan's distances are expressed in expected moves", q?.plan !== null && (q?.plan?.targetMoves ?? 0) > 2, q?.plan);
  check("and the line flags a far target", q?.lines.some((l) => l.includes("目標偏遠")) === true, q?.lines);
  check("a wait plan keeps the base stats without plan numbers", withPlan(quantStats(flat, 100), flat, "long", { entry: null, stop_loss: null, take_profit: null })?.plan === null);
}

check("too few bars → null", quantStats(series(10, () => 1), 100) === null);

report("quant");

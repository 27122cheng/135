import { check, report } from "./_harness";
import { CONDITIONS, VERIFY_FLOOR, buildContext, runLab } from "@/lib/analysis/lab";
import type { Candle } from "@/lib/data-sources/ohlcv";

/**
 * 實驗室.
 *
 * The property that matters is not "does it find good conditions" — on any
 * one price series a search will always find *something*. It is that the lab
 * cannot report a discovery the hold-out half does not support, and that it
 * says how many hypotheses it tested so the reader can price the luck.
 */

function bars(fn: (i: number) => number, n: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const c = fn(i);
    out.push({
      time: new Date(Date.UTC(2020, 0, 1 + i)).toISOString(),
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

// ── the conditions are well-formed ────────────────────────────────
{
  check("every condition has a distinct id",
    new Set(CONDITIONS.map((c) => c.id)).size === CONDITIONS.length);
  check("and a stated rationale",
    CONDITIONS.every((c) => c.label.length > 0 && c.rationale.length > 0));

  // A condition that throws would take the whole sweep down; the context is
  // deliberately full of nulls during warm-up.
  const ctx = buildContext(bars((i) => 100 + i * 0.3, 300));
  let threw: string | null = null;
  for (const c of CONDITIONS) {
    for (const i of [0, 1, 5, 30, 60, 150, 299]) {
      for (const d of ["long", "short"] as const) {
        try {
          c.test(ctx, i, d);
        } catch (err) {
          threw = `${c.id}@${i}/${d}: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }
  }
  check("no condition throws during warm-up or at the edges", threw === null, threw);
}

// ── the hold-out split is real ────────────────────────────────────
{
  const r = runLab(meta, bars((i) => 100 + i * 0.4 + Math.sin(i / 5) * 3, 400), "long")!;
  check("a report is produced", r !== null);
  check("the baseline is measured on both halves",
    r.baseline.inSample.trades > 0 && r.baseline.outOfSample.trades > 0, r.baseline);
  check("the hold-out share is stated", r.notes.some((n) => n.includes("70%")), r.notes);
  check("and so is the multiple-testing count",
    r.notes.some((n) => n.includes("個假設")), r.notes);
  check("the false-positive estimate scales with the tests run",
    r.expectedFalsePositives === Math.round(r.tested * 0.05), {
      tested: r.tested, fp: r.expectedFalsePositives,
    });

  // Nothing may be marked verified on one half alone.
  const badlyVerified = [...r.solo, ...r.pairs].filter(
    (f) =>
      f.verified &&
      ((f.inSample.hitRate ?? 0) < r.floor || (f.outOfSample.hitRate ?? 0) < r.floor),
  );
  check("a finding is never verified on one half alone", badlyVerified.length === 0, badlyVerified);

  // Pairs may only be built from conditions that beat the baseline solo.
  const soloIds = new Set(r.solo.filter((f) => (f.lift ?? 0) > 0).map((f) => f.ids[0]));
  const wrongPair = r.pairs.filter((p) => !p.ids.every((id) => soloIds.has(id)));
  check("combinations are built only from conditions that beat the baseline",
    wrongPair.length === 0, wrongPair.map((p) => p.ids));

  check("every reported finding meets the 100-trade floor",
    [...r.solo, ...r.pairs].every((f) => f.inSample.trades >= 100),
    [...r.solo, ...r.pairs].filter((f) => f.inSample.trades < 100).map((f) => f.inSample.trades));
  check("the adoption floor is 80%", r.floor === 0.8 && VERIFY_FLOOR === 0.8, r.floor);
  check("the criteria are stated in the report",
    r.notes.some((n) => n.includes("100") && n.includes("80%")), r.notes);

  // Combinations are no longer fixed at two — but every one of them is built
  // only from conditions that beat the baseline solo, at any depth.
  const deeper = r.pairs.filter((f) => f.ids.length > 2);
  check("combinations can go deeper than two when the sample survives",
    r.pairs.every((f) => f.ids.length >= 2), r.pairs.map((f) => f.ids.length));
  check("and every member of a deep combination beat the baseline solo",
    deeper.every((f) => f.ids.every((id) => soloIds.has(id))), deeper.map((f) => f.ids));
  check("no combination repeats a condition",
    r.pairs.every((f) => new Set(f.ids).size === f.ids.length));
  check("cost is deducted and stated", r.costPct > 0, r.costPct);

  // 結算率 — every entry the walk took is accounted for, not only the ones
  // that reached a stop or a target. A hit rate over a self-selected subset is
  // the quiet way a backtest flatters itself.
  const all = [r.baseline.inSample, r.baseline.outOfSample, ...r.solo.map((f) => f.inSample)];
  check("every entry taken is counted, resolved or not",
    all.every((s) => s.entries >= s.trades && s.unresolved === s.entries - s.trades), all);
  check("and a condition never reports more resolutions than entries",
    [...r.solo, ...r.pairs].every((f) => f.inSample.trades <= f.inSample.entries));
  check("the resolution rate is stated in the report",
    r.notes.some((n) => n.includes("結算率")), r.notes);
}

// ── a relentless uptrend should favour long conditions ────────────
//
// Not a claim about markets — a sanity check that the machinery measures
// what it says it measures. If a strictly rising series does not produce a
// high long hit rate, the walk is wrong.
{
  const up = runLab(meta, bars((i) => 100 * 1.004 ** i, 400), "long")!;
  check("a rising series gives longs a high baseline",
    (up.baseline.inSample.hitRate ?? 0) > 0.8, up.baseline.inSample);
  const down = runLab(meta, bars((i) => 100 * 1.004 ** i, 400), "short")!;
  check("and shorts a low one", (down.baseline.inSample.hitRate ?? 1) < 0.2, down.baseline.inSample);
}

// ── noise must not manufacture a verified finding ─────────────────
//
// A deterministic pseudo-random walk has no edge to find. Anything the lab
// marks 通過 here would be the over-fitting this design exists to prevent —
// and the hold-out is what has to catch it.
{
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };
  let price = 100;
  const walk = bars(() => {
    price *= 1 + rand() * 0.02;
    return price;
  }, 500);
  const r = runLab(meta, walk, "long")!;
  check("a random walk yields no verified condition", r.verified.length === 0,
    r.verified.map((f) => `${f.labels.join("+")} in=${f.inSample.hitRate} out=${f.outOfSample.hitRate}`));
  check("and the report says so rather than going quiet",
    r.notes.some((n) => n.includes("沒有任何條件通過")), r.notes);
}

// ── too little history is refused, not guessed at ─────────────────
{
  check("a short series returns null", runLab(meta, bars((i) => 100 + i, 50), "long") === null);
}

report("實驗室");

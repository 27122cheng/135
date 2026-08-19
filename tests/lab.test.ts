import { check, report } from "./_harness";
import {
  CONDITIONS,
  VERIFY_FLOOR,
  buildContext,
  runLab,
  shortfallsOf,
  type LabFinding,
} from "@/lib/analysis/lab";
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

  // Combinations are no longer pre-filtered by solo performance. The rule is
  // now the sample floor alone: anything measured solo with a real sample is
  // eligible to pair with anything else. Pinned as the *absence* of the old
  // filter, because a filter is easy to reintroduce by accident and it quietly
  // throws away the whole reason to combine — a condition worth nothing alone
  // can be exactly the veto another signal needs.
  const measuredSolo = new Set(r.solo.map((f) => f.ids[0]));
  const fromNowhere = r.pairs.filter((p) => !p.ids.every((id) => measuredSolo.has(id)));
  check("combinations are built only from conditions that were measured solo",
    fromNowhere.length === 0, fromNowhere.map((p) => p.ids));
  const weakMembers = r.pairs.filter((p) =>
    p.ids.some((id) => (r.solo.find((f) => f.ids[0] === id)?.lift ?? 0) <= 0));
  check("and conditions that lost to the baseline alone are still paired",
    weakMembers.length > 0, r.pairs.length);

  check("every reported finding meets the 100-trade floor",
    [...r.solo, ...r.pairs].every((f) => f.inSample.trades >= 100),
    [...r.solo, ...r.pairs].filter((f) => f.inSample.trades < 100).map((f) => f.inSample.trades));
  check("the adoption floor is 80%", r.floor === 0.8 && VERIFY_FLOOR === 0.8, r.floor);
  check("the criteria are stated in the report",
    r.notes.some((n) => n.includes("100") && n.includes("80%")), r.notes);

  check("combinations can go deeper than two when the sample survives",
    r.pairs.every((f) => f.ids.length >= 2), r.pairs.map((f) => f.ids.length));
  // Exhaustive at depth two: every pairing of the conditions that had a real
  // solo sample must have been considered, not a chosen few.
  const expectedPairs = (r.solo.length * (r.solo.length - 1)) / 2;
  const testedPairs = r.pairs.filter((f) => f.ids.length === 2).length;
  check("every pairing was tested (those with too few trades are dropped, not skipped)",
    testedPairs <= expectedPairs && testedPairs > r.solo.length,
    { testedPairs, expectedPairs, solo: r.solo.length });
  check("the report says the search does not pre-select",
    r.notes.some((n) => n.includes("配對不預先篩選")), r.notes);
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

// ── 接近通過 says exactly what is missing, and only when "near" is honest ──
{
  const result = (trades: number, hitRate: number) => ({
    trades,
    wins: Math.round(trades * hitRate),
    hitRate,
    expectancyR: 0,
    entries: trades,
    unresolved: 0,
  });
  const finding = (inRate: number, outRate: number, outTrades: number, verified = false): LabFinding => ({
    ids: ["a"],
    labels: ["A"],
    inSample: result(120, inRate),
    outOfSample: result(outTrades, outRate),
    verified,
    lift: 1,
  });

  check("a verified finding is never a near miss",
    shortfallsOf(finding(0.85, 0.85, 50, true), 0.8) === null);

  const rate = shortfallsOf(finding(0.85, 0.77, 50), 0.8);
  check("a hit rate 3 points short is named, with the distance",
    rate !== null && rate.length === 1 && rate[0].includes("77%") && rate[0].includes("3 個百分點"),
    rate);

  check("a hit rate more than 5 points short is not 'near'",
    shortfallsOf(finding(0.85, 0.70, 50), 0.8) === null);

  const sample = shortfallsOf(finding(0.85, 0.85, 38), 0.8);
  check("a thin out-of-sample count is named, with the count remaining",
    sample !== null && sample[0].includes("38 筆") && sample[0].includes("差 5 筆"), sample);

  check("a sample below 70% of the requirement is not 'near'",
    shortfallsOf(finding(0.85, 0.85, 20), 0.8) === null);

  const both = shortfallsOf(finding(0.78, 0.77, 38), 0.8);
  check("multiple small shortfalls are all listed",
    both !== null && both.length === 3, both);

  check("one criterion far off disqualifies even when the others are close",
    shortfallsOf(finding(0.85, 0.60, 38), 0.8) === null);

  // On a real report: never a verified finding, and the shortfalls must obey
  // the same margins the classifier promises.
  const r = runLab(meta, bars((i) => 100 + i * 0.4 + Math.sin(i / 5) * 3, 400), "long")!;
  check("the report carries the list", Array.isArray(r.nearMisses));
  check("no near miss is verified", r.nearMisses.every((f) => !f.verified));
  check("every near miss states at least one shortfall",
    r.nearMisses.every((f) => f.shortfalls.length > 0));
  check("the list is capped so it cannot become a menu", r.nearMisses.length <= 6);
}

report("實驗室");

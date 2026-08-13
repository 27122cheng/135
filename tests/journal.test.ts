import { check, report } from "./_harness";
import { computeSeverity } from "@/lib/journal/severity";
import {
  applyGradePenalties,
  assertNeverLoosened,
  computeInterventions,
  DEFAULT_EFFECTS,
  downgrade,
  isMainSession,
  summariseTags,
  triggeredTags,
} from "@/lib/journal/interventions";
import { computeReviewStats, computeTrackRecord } from "@/lib/journal/stats";
import { applyTrendAlignmentGate, gradeSignal } from "@/lib/scoring";
import type { JournalEntry } from "@/types/journal";
import type { BiasItem, Grade } from "@/types/signal";

const GRADES: Grade[] = ["no-trade", "C", "B", "A", "A+"];
const rank = (g: Grade) => GRADES.indexOf(g);

let seq = 0;
function entry(over: Partial<JournalEntry> = {}): JournalEntry {
  seq++;
  return {
    id: `id-${seq}`,
    signal_id: null,
    symbol: "XAUUSD",
    direction: "long",
    grade: "B",
    entry_price: 2000,
    exit_price: 1980,
    result: "loss",
    pnl_pct: -1,
    closed_at: `2026-01-${String(seq).padStart(2, "0")}T00:00:00.000Z`,
    stop_reason_tag: "S3",
    severity: 3,
    review_note: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

// ── 期望值 — the number 勝率 gets mistaken for ────────────────────
{
  const auto = (result: "win" | "loss", pnl: number) =>
    entry({ result, pnl_pct: pnl, review_note: "[自動追蹤] 停利/停損" });

  // 70% win rate, losing money: seven +0.5% winners, three −2% losers.
  const losingHighWinRate = computeTrackRecord([
    ...Array.from({ length: 7 }, () => auto("win", 0.5)),
    ...Array.from({ length: 3 }, () => auto("loss", -2)),
  ]).real;
  check("a 70% win rate is reported", losingHighWinRate.winRate === 70, losingHighWinRate.winRate);
  check("with its 0.25 payoff ratio", losingHighWinRate.payoffRatio === 0.25, losingHighWinRate.payoffRatio);
  check("its breakeven bar is 80%", losingHighWinRate.breakevenWinRate === 80, losingHighWinRate.breakevenWinRate);
  check("and its expectancy is negative",
    (losingHighWinRate.expectancyPct ?? 0) < 0, losingHighWinRate.expectancyPct);

  // 40% win rate, making money: the mirror case the floors are built around.
  const winningLowWinRate = computeTrackRecord([
    ...Array.from({ length: 4 }, () => auto("win", 3)),
    ...Array.from({ length: 6 }, () => auto("loss", -1)),
  ]).real;
  check("a 40% win rate at 3:1 payoff has positive expectancy",
    (winningLowWinRate.expectancyPct ?? 0) > 0, winningLowWinRate.expectancyPct);
  check("and a breakeven bar of 25%", winningLowWinRate.breakevenWinRate === 25);

  // No losses observed: a payoff ratio with a missing denominator stays null.
  const allWins = computeTrackRecord([auto("win", 1), auto("win", 2)]).real;
  check("all-wins has no payoff ratio", allWins.payoffRatio === null);
  check("but still has an expectancy", allWins.expectancyPct === 1.5, allWins.expectancyPct);
}

// ── 實績校準 — realized outcomes audit the backtest floor ─────────
{
  const real = (result: "win" | "loss") =>
    entry({ result, pnl_pct: result === "win" ? 1.5 : -1, review_note: "[自動追蹤] x" });
  const paper = (result: "win" | "loss") =>
    entry({ result, pnl_pct: 1, review_note: "[自動追蹤][參考價位紙上追蹤] x" });

  // 4 wins / 8 losses = 33% realized against a 70% promise → +10 points.
  const bad = computeInterventions([
    ...Array.from({ length: 4 }, () => real("win")),
    ...Array.from({ length: 8 }, () => real("loss")),
  ]);
  check("a failing audit raises the day floor", bad.dayHitRateFloorBump === 0.1, bad.dayHitRateFloorBump);
  check("and explains itself with the numbers",
    bad.applied.some((a) => a.effect.includes("+10 個百分點") && a.evidence.includes("33%")),
    bad.applied.map((a) => a.effect));

  // 6/12 = 50% → the milder +5.
  const mediocre = computeInterventions([
    ...Array.from({ length: 6 }, () => real("win")),
    ...Array.from({ length: 6 }, () => real("loss")),
  ]);
  check("a mediocre audit raises it less", mediocre.dayHitRateFloorBump === 0.05);

  // 8/12 = 67% — close enough to the promise; no bump.
  const fine = computeInterventions([
    ...Array.from({ length: 8 }, () => real("win")),
    ...Array.from({ length: 4 }, () => real("loss")),
  ]);
  check("a healthy audit leaves the floor alone", fine.dayHitRateFloorBump === 0);

  // Under 10 resolved, the sample is noise and must not move the floor.
  const thin = computeInterventions([
    ...Array.from({ length: 3 }, () => real("win")),
    ...Array.from({ length: 5 }, () => real("loss")),
  ]);
  check("a thin sample does not calibrate", thin.dayHitRateFloorBump === 0);

  // Paper fills are assumed perfect and never claimed the floor — excluded.
  const paperOnly = computeInterventions(Array.from({ length: 12 }, () => paper("loss")));
  check("paper tracking cannot move the real floor", paperOnly.dayHitRateFloorBump === 0);
}

// ── grade table ───────────────────────────────────────────────────
{
  // total is always bias + structure in real use, so the triples here are too.
  check("bias 7 / structure 8 now grades A, not no-trade", gradeSignal(7, 8, 15) === "A");
  check("A+ still needs all three", gradeSignal(10, 4, 14) === "A+");
  check("A+ blocked by thin structure falls to A", gradeSignal(11, 3, 14) === "A");
  check("A band unchanged", gradeSignal(6, 4, 10) === "A");
  check("B band unchanged", gradeSignal(5, 4, 9) === "B");
  check("C band unchanged", gradeSignal(2, 2, 4) === "C");
  check("disqualifiers still win", gradeSignal(0, 5, 14) === "no-trade");
  check("total 10-13 with weak bias stays no-trade", gradeSignal(3, 9, 12) === "no-trade");

  let anyNoTrade = false;
  for (let ess = 1; ess <= 12; ess++) {
    for (let bias = 6; bias <= 14; bias++) {
      if (gradeSignal(bias, ess, bias + ess) === "no-trade") anyNoTrade = true;
    }
  }
  check("nothing with bias>=6 and structure>0 falls to no-trade", !anyNoTrade);

  // ── 逆勢不對稱 ──
  // A direction fighting the weight-2 技術面 trend must clear the A+ bias bar
  // (8) or lose a notch; with-trend and trendless signals are untouched.
  {
    const item = (
      dimension: BiasItem["dimension"],
      direction: BiasItem["direction"],
      weight: 0 | 1 | 2,
    ): BiasItem =>
      ({ dimension, direction, weight, factor: "f", evidence: "e" }) as BiasItem;
    const trendShort = [item("技術面", "short", 2), item("基本面", "long", 1)];

    const gated = applyTrendAlignmentGate("A", "long", trendShort, 6);
    check("a counter-trend A with bias 6 drops to B", gated.grade === "B", gated);
    check("and the note names the rule", gated.note?.includes("逆勢降級") === true, gated.note);

    const held = applyTrendAlignmentGate("A", "long", trendShort, 8);
    check("bias 8 keeps its grade against the trend", held.grade === "A");
    check("but the counter-trend fact is still stated",
      held.note?.includes("逆勢訊號") === true, held.note);

    check("with-trend signals are untouched",
      applyTrendAlignmentGate("A", "short", trendShort, 6).grade === "A");
    check("weight-1 technical items are triggers, not trend",
      applyTrendAlignmentGate("A", "long", [item("技術面", "short", 1)], 6).grade === "A");
    check("no technical evidence means no gate",
      applyTrendAlignmentGate("B", "long", [item("基本面", "short", 2)], 4).grade === "B");
    check("a counter-trend B drops below the entry floor",
      applyTrendAlignmentGate("B", "long", trendShort, 4).grade === "C");
  }

  // The A cap is gone: crossing 13 -> 14 no longer steps a grade down.
  check("total 13 grades A", gradeSignal(6, 7, 13) === "A");
  check("total 14 with the same bias still grades A", gradeSignal(6, 8, 14) === "A");
  check("a strong bias with thin structure keeps A", gradeSignal(8, 3, 11) === "A");

  // With adequate conviction, adding structure must never lower the grade.
  let inverted: string | null = null;
  for (let bias = 6; bias <= 14; bias++) {
    for (let ess = 1; ess <= 14; ess++) {
      const before = rank(gradeSignal(bias, ess, bias + ess));
      const after = rank(gradeSignal(bias, ess + 1, bias + ess + 1));
      if (after < before) inverted = `bias=${bias} ess=${ess}->${ess + 1}`;
    }
  }
  check("more structure never lowers the grade (bias>=6)", inverted === null, inverted);

  // The one inversion left, pinned so it can't move unnoticed: below the bias
  // floor the B band and the 14+ catch-all sandwich a no-trade middle.
  check("weak bias, total 9 grades B", gradeSignal(5, 4, 9) === "B");
  check("weak bias, total 12 is no-trade", gradeSignal(5, 7, 12) === "no-trade");
  check("weak bias, total 14 grades B again", gradeSignal(5, 9, 14) === "B");

  let everBetter = false;
  for (let bias = -2; bias <= 14; bias++) {
    for (let ess = 0; ess <= 10; ess++) {
      if (rank(gradeSignal(bias, ess, bias + ess, 2)) > rank(gradeSignal(bias, ess, bias + ess, 0))) {
        everBetter = true;
      }
    }
  }
  check("the S1 bias bump never improves a grade", !everBetter);
}

// ── severity ──────────────────────────────────────────────────────
{
  check("floor is 1, not 0", computeSeverity({ tag: "S1", pnlPct: -1, history: [] }).severity === 1);
  check("preventable alone scores 2", computeSeverity({ tag: "S3", pnlPct: -1, history: [] }).severity === 2);

  const hist = [entry({ pnl_pct: -1, stop_reason_tag: "S1" }), entry({ pnl_pct: -1, stop_reason_tag: "S1" })];
  const c = computeSeverity({ tag: "S3", pnlPct: -2, history: hist });
  check("outsized loss adds 1", c.severity === 3, c);
  check("average loss comes from prior losses", c.averageLossPct === 1, c);
  check("exactly 1.5x does not trigger", !computeSeverity({ tag: "S3", pnlPct: -1.5, history: hist }).isOutsizedLoss);

  const repeat = [entry({ stop_reason_tag: "S3" }), entry({ stop_reason_tag: "S3" }), entry({ stop_reason_tag: "S3" })];
  check("repeat offender adds 2", computeSeverity({ tag: "S3", pnlPct: -1, history: repeat }).severity === 4);
  check("all three terms cap at 5", computeSeverity({ tag: "S3", pnlPct: -5, history: repeat }).severity === 5);

  const withWins = [entry({ result: "win", pnl_pct: 3, stop_reason_tag: null }), entry({ pnl_pct: -2 })];
  check(
    "wins excluded from the average loss",
    computeSeverity({ tag: "S1", pnlPct: -2.5, history: withWins }).averageLossPct === 2,
  );

  const old = Array.from({ length: 25 }, () => entry({ stop_reason_tag: "S8" }));
  const recent = Array.from({ length: 20 }, () => entry({ stop_reason_tag: "S1" }));
  check(
    "the repeat window is the last 20 only",
    computeSeverity({ tag: "S8", pnlPct: -1, history: [...recent, ...old] }).sameTagInLast20 === 0,
  );
}

// ── intervention triggers ─────────────────────────────────────────
{
  check(
    "2 occurrences is below the count threshold",
    triggeredTags(summariseTags([entry({ severity: 5 }), entry({ severity: 5 })])).length === 0,
  );
  check(
    "low average severity does not trigger",
    triggeredTags(summariseTags(Array.from({ length: 5 }, () => entry({ severity: 2 })))).length === 0,
  );

  const eff = computeInterventions(Array.from({ length: 3 }, () => entry({ stop_reason_tag: "S3", severity: 4 })));
  check("S3 raises the stop buffer to 1.0 ATR", eff.stopBufferAtrMultiple === 1.0);
  check("S3 records one applied intervention", eff.applied.length === 1 && eff.applied[0].tag === "S3");
  check("it cites the triggering dates", eff.applied[0].triggered_by.length === 3);

  const s2 = computeInterventions(Array.from({ length: 4 }, () => entry({ stop_reason_tag: "S2", severity: 3 })));
  check("S2 narrows the entry zone by 30%", Math.abs(s2.entryZoneWidthFactor - 0.7) < 1e-9);
  check("S2 requires pullback confirmation", s2.requirePullbackConfirmation);

  const s1 = computeInterventions(Array.from({ length: 3 }, () => entry({ stop_reason_tag: "S1", severity: 3 })));
  check("S1 bumps the bias threshold by 2", s1.biasScoreThresholdBump === 2);

  // S6 is a discipline problem the system cannot mechanically fix.
  const s6 = computeInterventions(Array.from({ length: 6 }, () => entry({ stop_reason_tag: "S6", severity: 5 })));
  check("S6 applies no penalty", s6.applied.length === 0, s6.applied);
  check(
    "S6 leaves every knob at default",
    s6.biasScoreThresholdBump === 0 && s6.entryZoneWidthFactor === 1 && s6.stopBufferAtrMultiple === 0.5,
  );

  const mixed = [
    entry({ stop_reason_tag: "S3", severity: null }),
    entry({ stop_reason_tag: "S3", severity: 4 }),
    entry({ stop_reason_tag: "S3", severity: 4 }),
  ];
  check("null severity excluded from the mean", summariseTags(mixed)[0].avgSeverity === 4);
  check("null-severity rows still count in the tally", summariseTags(mixed)[0].count === 3);

  const buried = [
    ...Array.from({ length: 30 }, () => entry({ stop_reason_tag: "S1", severity: 1 })),
    ...Array.from({ length: 5 }, () => entry({ stop_reason_tag: "S7", severity: 5 })),
  ];
  check("entries beyond the 30-row lookback are ignored",
    triggeredTags(summariseTags(buried)).every((t) => t.tag !== "S7"));
}

// ── downgrade-only ────────────────────────────────────────────────
{
  check("downgrade steps one level", downgrade("A+") === "A" && downgrade("C") === "no-trade");
  check("no-trade is the floor", downgrade("no-trade") === "no-trade");
  check("03:00 UTC is off-session", !isMainSession(new Date("2026-01-05T03:00:00Z")));
  check("14:00 UTC is on-session", isMainSession(new Date("2026-01-05T14:00:00Z")));

  const night = new Date("2026-01-05T03:00:00Z");
  const day = new Date("2026-01-05T14:00:00Z");
  const ctx = {
    highImpactEventWithin24h: false,
    eventDataAvailable: true,
    generatedAt: night,
    fundamentalOpposesSignal: false,
    positioningExtremeOpposesSignal: false,
  };

  check("S5 downgrades off-session",
    applyGradePenalties("A", { ...DEFAULT_EFFECTS, downgradeOutsideMainSession: true }, ctx).grade === "B");
  check("S5 leaves on-session alone",
    applyGradePenalties("A", { ...DEFAULT_EFFECTS, downgradeOutsideMainSession: true }, { ...ctx, generatedAt: day }).grade === "A");
  check("S7 forces no-trade",
    applyGradePenalties("A+", { ...DEFAULT_EFFECTS, noTradeOnFundamentalConflict: true },
      { ...ctx, generatedAt: day, fundamentalOpposesSignal: true }).grade === "no-trade");
  check("S8 forces no-trade",
    applyGradePenalties("A+", { ...DEFAULT_EFFECTS, noTradeOnPositioningConflict: true },
      { ...ctx, generatedAt: day, positioningExtremeOpposesSignal: true }).grade === "no-trade");

  // S4 without a calendar source must not act on an unknown.
  const s4 = { ...DEFAULT_EFFECTS, downgradeOnHighImpactEvent: true };
  const unknown = applyGradePenalties("A", s4, { ...ctx, generatedAt: day, eventDataAvailable: false });
  check("S4 does not downgrade on unknown event data", unknown.grade === "A");
  check("S4 says so rather than staying silent", unknown.notes.some((n) => n.includes("無經濟數據日曆")));
  check("S4 downgrades on a confirmed event",
    applyGradePenalties("A", s4, { ...ctx, generatedAt: day, highImpactEventWithin24h: true }).grade === "B");

  check("penalties stack downward",
    applyGradePenalties("A+", { ...DEFAULT_EFFECTS, downgradeOutsideMainSession: true, downgradeOnHighImpactEvent: true },
      { ...ctx, highImpactEventWithin24h: true }).grade === "B");

  // Exhaustive: no combination of inputs may raise a grade.
  let everUp = false;
  const all = {
    ...DEFAULT_EFFECTS,
    downgradeOnHighImpactEvent: true,
    downgradeOutsideMainSession: true,
    noTradeOnFundamentalConflict: true,
    noTradeOnPositioningConflict: true,
  };
  for (const g of GRADES) {
    for (const off of [true, false]) {
      for (const event of [true, false]) {
        for (const avail of [true, false]) {
          for (const fund of [true, false]) {
            for (const pos of [true, false]) {
              const out = applyGradePenalties(g, all, {
                highImpactEventWithin24h: event,
                eventDataAvailable: avail,
                generatedAt: off ? night : day,
                fundamentalOpposesSignal: fund,
                positioningExtremeOpposesSignal: pos,
              });
              if (rank(out.grade) > rank(g)) everUp = true;
            }
          }
        }
      }
    }
  }
  check("no input combination can raise a grade (160 cases)", !everUp);
}

// ── the loosening guard ───────────────────────────────────────────
{
  const rejects = (effects: Parameters<typeof assertNeverLoosened>[0]) => {
    try {
      assertNeverLoosened(effects);
      return false;
    } catch {
      return true;
    }
  };
  check("a widened entry zone is rejected", rejects({ ...DEFAULT_EFFECTS, entryZoneWidthFactor: 1.5 }));
  check("a shrunk stop buffer is rejected", rejects({ ...DEFAULT_EFFECTS, stopBufferAtrMultiple: 0.1 }));
  check("a negative bias bump is rejected", rejects({ ...DEFAULT_EFFECTS, biasScoreThresholdBump: -1 }));
  check("the defaults pass", !rejects(DEFAULT_EFFECTS));
}

// ── review stats ──────────────────────────────────────────────────
{
  const entries = [
    entry({ stop_reason_tag: "S3", severity: 4, pnl_pct: -2, grade: "A", result: "loss" }),
    entry({ stop_reason_tag: "S3", severity: 2, pnl_pct: -1, grade: "A", result: "loss" }),
    entry({ stop_reason_tag: "S1", severity: 1, pnl_pct: -5, grade: "B", result: "loss" }),
    entry({ stop_reason_tag: null, severity: null, pnl_pct: 4, grade: "A", result: "win" }),
    entry({ stop_reason_tag: null, severity: null, pnl_pct: 0, grade: "A", result: "breakeven" }),
  ];
  const s = computeReviewStats(entries);
  check("counts every entry", s.totalEntries === 5);
  check("distribution covers only tagged losses", s.tagDistribution.reduce((n, d) => n + d.count, 0) === 3);
  check("S3 share is 2/3", Math.abs(s.tagDistribution[0].sharePct - 66.67) < 0.01);
  check("S3 average severity is 3", s.tagDistribution[0].avgSeverity === 3);
  check("loss ranking puts the costliest first", s.lossRanking[0].tag === "S1");

  const a = s.gradePerformance.find((g) => g.grade === "A")!;
  check("grade A counts 4 trades", a.trades === 4, a);
  check("win rate excludes breakeven", a.winRate === 33.33, a);
  check("expectancy includes breakeven", Math.abs((a.expectancyPct ?? 0) - 0.25) < 1e-9, a);
  check("grades with no trades are omitted", !s.gradePerformance.some((g) => g.grade === "no-trade"));
  check("trend is chronological", s.severityTrend[0].closedAt < s.severityTrend[2].closedAt);
  check("rolling mean starts at the first value", s.severityTrend[0].rollingMean === s.severityTrend[0].severity);
}

report("journal + interventions");

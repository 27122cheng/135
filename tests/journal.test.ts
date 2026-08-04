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
import { computeReviewStats } from "@/lib/journal/stats";
import { gradeSignal } from "@/lib/scoring";
import type { JournalEntry } from "@/types/journal";
import type { Grade } from "@/types/signal";

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

// ── grade table ───────────────────────────────────────────────────
{
  check("total 15 / bias 7 no longer falls to no-trade", gradeSignal(7, 8, 15) === "B");
  check("A+ still needs all three", gradeSignal(8, 4, 14) === "A+");
  check("14+ missing structure lands on B", gradeSignal(8, 3, 14) === "B");
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

  // Known residual, pinned so it can't shift unnoticed: the A band still caps
  // at 13, so 13 grades A while 14 grades B. Removing `totalScore <= 13` from
  // the A rule would close it — a scoring-policy call, not a bug fix.
  check("residual: total 13 grades A", gradeSignal(6, 7, 13) === "A");
  check("residual: total 14 grades B", gradeSignal(6, 8, 14) === "B");

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

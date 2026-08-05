import { check, report } from "./_harness";
import {
  levelFor,
  obstaclesBetween,
  planConfidence,
  takeProfitConfidence,
} from "@/lib/analysis/confidence";
import type { PathObstacle, TradeSignal } from "@/types/signal";

/**
 * 信心度. The rules that must not drift: it is computed rather than asked for,
 * a further target is never more confident than a nearer one, and obstacles in
 * the path cost something.
 */

function signal(over: Partial<TradeSignal> = {}): TradeSignal {
  return {
    symbol: "XAUUSD",
    direction: "long",
    grade: "A",
    bias_score: 8,
    entry_structure_score: 3,
    total_score: 11,
    entry_zone: { low: 2000, high: 2000, reason: "r" },
    stop_loss: { price: 1980, structure: "s", reason: "r", invalidation: "i" },
    take_profits: [
      { price: 2040, structure: "s1", reason: "r", allocation_pct: 50 },
      { price: 2080, structure: "s2", reason: "r", allocation_pct: 30 },
      { price: 2120, structure: "s3", reason: "r", allocation_pct: 20 },
    ],
    bias_items: [],
    entry_structures: [],
    path_obstacles: [],
    news_digest: null,
    narrative: "n",
    trade_plan: {
      stance: "enter",
      entry: 2000,
      stop_loss: 1980,
      take_profit: 2040,
      entry_reason: "r",
      stop_loss_reason: "r",
      take_profit_reason: "r",
      risk_reward: 2,
      confidence: "high",
      summary: "s",
      add_ons: [],
      wait_for: null,
      decided_by: "ai",
    },
    plan_backtest: null,
    interventions: [],
    data_gaps: [],
    generated_at: "2026-08-05T00:00:00Z",
    ...over,
  } as unknown as TradeSignal;
}

function obstacle(price: number, strength: 1 | 2 | 3): PathObstacle {
  return { price, type: "前高", timeframe: "H4", strength };
}

// ── it is computed, not asked for ─────────────────────────────────
{
  // Ten calls, one answer. The whole reason this exists rather than an AI field.
  const scores = new Set(Array.from({ length: 10 }, () => planConfidence(signal()).score));
  check("the same signal always scores the same", scores.size === 1, [...scores]);

  check("A+ outranks A", planConfidence(signal({ grade: "A+" })).score >
    planConfidence(signal({ grade: "A" })).score);
  check("A outranks B", planConfidence(signal({ grade: "A" })).score >
    planConfidence(signal({ grade: "B" })).score);
  check("no-trade is the floor", planConfidence(signal({ grade: "no-trade" })).score <
    planConfidence(signal({ grade: "C" })).score);

  // Every component that moved the number has to be listed, or the number is
  // just an assertion.
  const c = planConfidence(signal());
  check("the grade is always cited", c.factors.some((f) => f.includes("評等")), c.factors);
  check("the score stays in range", c.score >= 5 && c.score <= 95, c.score);
}

// ── the adjustments ───────────────────────────────────────────────
{
  const base = planConfidence(signal()).score;

  const gappy = planConfidence(signal({ data_gaps: ["a", "b", "c"] as string[] }));
  check("data gaps cost confidence", gappy.score < base, gappy.score);
  check("and are named", gappy.factors.some((f) => f.includes("資料缺口")), gappy.factors);
  // Capped, so a noisy day can't drive a good setup to the floor on its own.
  const veryGappy = planConfidence(signal({ data_gaps: Array(20).fill("x") as string[] }));
  check("the gap penalty is capped", veryGappy.score >= base - 15, veryGappy.score);

  const fallback = planConfidence(
    signal({ trade_plan: { ...signal().trade_plan, decided_by: "fallback" } }),
  );
  check("levels chosen by the default rules cost confidence", fallback.score < base);

  const better = planConfidence(
    signal({ trade_plan: { ...signal().trade_plan, risk_reward: 4 } }),
  );
  check("a better payoff helps", better.score > base, better.score);

  // A backtest below the sample floor must not move anything — noise laundered
  // into an evidence-shaped number is worse than no number.
  const tiny = planConfidence(
    signal({ plan_backtest: { resolved: 4, wins: 4, losses: 0, timeouts: 0, hitRate: 1,
      expectancyR: 1, horizonBars: 20, lookbackBars: 200 } as TradeSignal["plan_backtest"] }),
  );
  check("a 4-sample backtest does not move the score", tiny.score === base, tiny.score);
  check("but says why it was ignored",
    tiny.factors.some((f) => f.includes("不足以調整")), tiny.factors);

  const real = planConfidence(
    signal({ plan_backtest: { resolved: 20, wins: 16, losses: 4, timeouts: 0, hitRate: 0.8,
      expectancyR: 1, horizonBars: 20, lookbackBars: 200 } as TradeSignal["plan_backtest"] }),
  );
  check("a real sample does move it", real.score > base, real.score);
}

// ── per-target ────────────────────────────────────────────────────
{
  const s = signal();
  const t1 = takeProfitConfidence(s, 0);
  const t2 = takeProfitConfidence(s, 1);
  const t3 = takeProfitConfidence(s, 2);

  // The one property that must always hold: a further target is never a surer
  // thing than a nearer one on the same plan.
  check("TP1 ≥ TP2", t1.score >= t2.score, [t1.score, t2.score]);
  check("TP2 ≥ TP3", t2.score >= t3.score, [t2.score, t3.score]);
  check("TP1 starts from the plan's own score",
    t1.factors[0].includes(String(planConfidence(s).score)), t1.factors[0]);

  // Obstacles between entry and target cost confidence; ones beyond it don't.
  const blocked = takeProfitConfidence(
    signal({ path_obstacles: [obstacle(2020, 3)] }),
    0,
  );
  check("an obstacle in the path costs confidence", blocked.score < t1.score, blocked.score);
  check("and is named with its timeframe",
    blocked.factors.some((f) => f.includes("H4")), blocked.factors);

  const beyond = takeProfitConfidence(signal({ path_obstacles: [obstacle(2200, 3)] }), 0);
  check("an obstacle past the target is irrelevant", beyond.score === t1.score, beyond.score);

  const weak = takeProfitConfidence(signal({ path_obstacles: [obstacle(2020, 1)] }), 0);
  const strong = takeProfitConfidence(signal({ path_obstacles: [obstacle(2020, 3)] }), 0);
  check("a stronger obstacle costs more", strong.score < weak.score, [strong.score, weak.score]);

  check("a missing target is not scoreable", takeProfitConfidence(s, 9).score === 5);
  check("scores stay in range",
    [t1, t2, t3].every((t) => t.score >= 5 && t.score <= 95));
}

// ── obstacles between ─────────────────────────────────────────────
{
  const list = [obstacle(1990, 1), obstacle(2020, 2), obstacle(2100, 3)];
  check("only strictly-between obstacles count",
    obstaclesBetween(list, 2000, 2050).length === 1);
  // Direction must not matter — a short's target is below its entry.
  check("it works downwards too", obstaclesBetween(list, 2050, 2000).length === 1);
  check("endpoints are exclusive", obstaclesBetween(list, 2020, 2100).length === 0);
}

// ── the bands ─────────────────────────────────────────────────────
{
  check("70 is high", levelFor(70) === "high");
  check("69 is medium", levelFor(69) === "medium");
  check("45 is medium", levelFor(45) === "medium");
  check("44 is low", levelFor(44) === "low");
}

report("confidence");

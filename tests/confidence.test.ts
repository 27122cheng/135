import { check, report } from "./_harness";
import {
  CONFIDENT_ENTRY_MIN,
  clearsEntryBar,
  levelFor,
  obstaclesBetween,
  planConfidence,
  takeProfitConfidence,
} from "@/lib/analysis/confidence";
import type { PathObstacle, TradeSignal } from "@/types/signal";
import { AI_LIMITS } from "@/lib/ai";

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

// ── behaviour notes cost nothing ──────────────────────────────────
{
  // "本次不提供加倉點：評等 B…" is the add-on rule working as designed, filed
  // in data_gaps because that's the only free-text channel. Billing it −3 as
  // missing evidence made a signal lose confidence *because* one of its own
  // rules fired correctly.
  const clean = planConfidence(signal()).score;
  const noted = planConfidence(
    signal({
      data_gaps: ["本次不提供加倉點：評等 B 對方向的信心不足以加倉（僅 A / A+ 提供加倉點）"],
    }),
  ).score;
  check("a rule explaining itself does not cost confidence", noted === clean, [noted, clean]);

  const real = planConfidence(
    signal({ data_gaps: ["CFTC COT (XAUUSD) 取得失敗，且無可用快取"] }),
  ).score;
  check("while genuinely missing evidence still does", real < clean, [real, clean]);
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

  // Gaps are not all the same thing, and pricing them as if they were is what
  // put NAS100 at 59 against a bar of 60. A source that answered from cache
  // still answered; the AI's absence is already billed as the fallback penalty.
  const staleOnly = planConfidence(
    signal({ data_gaps: ["GDELT 新聞 本次取得失敗：HTTP 429，改用 4 小時前的快取結果（stale，非即時）"] as string[] }),
  );
  const missingOnly = planConfidence(
    signal({ data_gaps: ["CFTC COT 取得失敗：合約代碼查無資料"] as string[] }),
  );
  check("a source served from cache costs less than a missing one",
    staleOnly.score > missingOnly.score, [staleOnly.score, missingOnly.score]);
  check("and the split is spelled out",
    staleOnly.factors.some((f) => f.includes("改用快取")), staleOnly.factors);
  check("an AI outage is not charged here as well",
    planConfidence(signal({ data_gaps: ["所有 AI 供應商皆無法回應（429）"] as string[] })).score === base,
    planConfidence(signal({ data_gaps: ["所有 AI 供應商皆無法回應（429）"] as string[] })).score);

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

// ── the entry bar ─────────────────────────────────────────────────
{
  // 附加審查，不是主審：the operator's architecture instruction moved the
  // bar to the 「低」 boundary (levelFor < 45) — confidence vetoes only runs
  // whose evidence genuinely did not arrive, and annotates everything else.
  check("the bar is the 低-level boundary", CONFIDENT_ENTRY_MIN === 45);
  check("45 clears it", clearsEntryBar(45));
  check("44 does not", !clearsEntryBar(44));

  // The bar is high on purpose, and the arithmetic has to actually allow it —
  // a threshold nothing can ever reach is a disabled feature, not a strict one.
  const best = planConfidence(
    signal({
      grade: "A+",
      trade_plan: { ...signal().trade_plan, risk_reward: 3.5 },
      data_gaps: [] as string[],
      plan_backtest: { resolved: 30, wins: 21, losses: 9, timeouts: 0, hitRate: 0.7,
        expectancyR: 1, horizonBars: 20, lookbackBars: 200 } as TradeSignal["plan_backtest"],
    }),
  );
  check("a clean A+ with a proven geometry can clear it", clearsEntryBar(best.score), best.score);

  // The bar is a veto, not a second grading system — the grade still decides.
  // A+ has to survive a bad data day, or the feature is off again.
  const gappyBest = planConfidence(
    signal({
      grade: "A+",
      trade_plan: { ...signal().trade_plan, risk_reward: 3.5 },
      data_gaps: ["a", "b", "c", "d", "e"] as string[],
    }),
  );
  check("A+ still trades through five data gaps", clearsEntryBar(gappyBest.score),
    gappyBest.score);
  check("the gaps still cost the full 15",
    planConfidence(signal({ grade: "A+", trade_plan: { ...signal().trade_plan, risk_reward: 3.5 } }))
      .score - gappyBest.score === 15);

  // C is refused by the GRADE gate (MIN_ENTRY_GRADE) upstream — with the bar
  // at the 低 boundary, confidence no longer doubles that refusal, and the
  // division of labour is the point: the grade decides who qualifies, the
  // confidence veto catches evidence that failed to arrive.
  const cGradeBest = planConfidence(
    signal({ grade: "C", trade_plan: { ...signal().trade_plan, risk_reward: 6 } }),
  );
  check("a C grade's refusal belongs to the grade gate, not this one",
    cGradeBest.score < 60, cGradeBest.score);

  // The case that made "no signal, ever" arithmetically guaranteed: the free AI
  // tier is exhausted, so every plan is a fallback, and a normal run has a
  // handful of gaps. With the old −10 even A+ could not reach 60 in that state.
  const exhausted = (grade: TradeSignal["grade"]) =>
    planConfidence(
      signal({
        grade,
        trade_plan: { ...signal().trade_plan, decided_by: "fallback", risk_reward: 2.5 },
        data_gaps: ["a", "b", "c", "d", "e"] as string[],
      }),
    );

  check("A+ can still trade with no AI and five gaps", clearsEntryBar(exhausted("A+").score),
    exhausted("A+").score);
  // A and B on a five-gap fallback day now trade too — the exact runs the
  // live logs showed being vetoed on every ordinary degraded day (EURUSD:
  // confidence 52, blocked at the old 60). The gaps still cost their points
  // and are listed on the card; the veto is reserved for 「低」, where the
  // evidence genuinely did not arrive.
  check("A trades through five sources being down", clearsEntryBar(exhausted("A").score),
    exhausted("A").score);
  check("so does B — annotated, not vetoed", clearsEntryBar(exhausted("B").score),
    exhausted("B").score);
  // The veto still has teeth where it should: a signal whose score lands in
  // 低 (the live case was XAUUSD at 5 with every quote source dead).
  check("a 低-level score is still vetoed", !clearsEntryBar(30));

  // But on a healthy run A must trade even with no AI at all — otherwise the
  // bar is once again something nothing can clear.
  const healthy = planConfidence(
    signal({
      grade: "A",
      trade_plan: { ...signal().trade_plan, decided_by: "fallback", risk_reward: 2.5 },
      data_gaps: ["a", "b"] as string[],
    }),
  );
  check("A trades on a healthy run without AI", clearsEntryBar(healthy.score), healthy.score);

  check("the fallback penalty is 5, not 10",
    planConfidence(signal()).score -
      planConfidence(signal({ trade_plan: { ...signal().trade_plan, decided_by: "fallback" } }))
        .score === 5);
}

// ── the bands ─────────────────────────────────────────────────────
{
  check("70 is high", levelFor(70) === "high");
  check("69 is medium", levelFor(69) === "medium");
  check("45 is medium", levelFor(45) === "medium");
  check("44 is low", levelFor(44) === "low");
}

// ── the quota lesson, pinned ──────────────────────────────────────
//
// Not about confidence, but it belongs beside it: a fallback plan costs 10
// points, and the reason every plan became a fallback was an exhausted free
// AI tier. The limits below are the measured ones, not the documented ones.
{
  check("gemini's daily budget is the measured one, not the docs' 1500",
    AI_LIMITS.gemini.perDay === 200, AI_LIMITS.gemini.perDay);
  // Groq's real ceiling is tokens/day (100k). This tracker counts requests, so
  // the limit is the honest translation of that budget, not a request figure
  // copied off a pricing page.
  check("groq declares a daily ceiling at all", AI_LIMITS.groq.perDay !== undefined);
  check("and it is small enough to survive a day", (AI_LIMITS.groq.perDay ?? 999) <= 30,
    AI_LIMITS.groq.perDay);
  check("per-minute limits stay under the published free tiers",
    (AI_LIMITS.gemini.perMinute ?? 99) <= 15 && (AI_LIMITS.groq.perMinute ?? 99) <= 30);
}

report("confidence");

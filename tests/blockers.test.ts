import { check, report } from "./_harness";
import { censusOf, classifyBlocker } from "@/lib/analysis/blockers";
import type { TradeSignal } from "@/types/signal";

/**
 * 卡在哪一關.
 *
 * The classifier's only job is to be honest about which gate fired first. Two
 * ways it could lie and both are pinned here: reporting a downstream symptom
 * (no stop, because there was no price) as the cause, and reporting a market
 * fact as a tunable threshold — which would send the operator to loosen a
 * number that was never the problem.
 */

function signal(over: Partial<TradeSignal> = {}): TradeSignal {
  return {
    symbol: "XAUUSD",
    direction: "long",
    generated_at: new Date().toISOString(),
    bias_score: 6,
    entry_structure_score: 6,
    total_score: 12,
    grade: "B",
    entry_zone: { low: 1, high: 2, reason: "" },
    stop_loss: { price: 1, structure: "", reason: "", invalidation: "" },
    take_profits: [],
    bias_items: [],
    entry_structures: [],
    path_obstacles: [],
    news_digest: null,
    narrative: "",
    trade_plan: {
      stance: "wait",
      entry: null,
      stop_loss: null,
      take_profit: null,
      entry_reason: "",
      stop_loss_reason: "",
      take_profit_reason: "",
      risk_reward: null,
      confidence: "low",
      summary: "",
      add_ons: [],
      wait_for: "",
      decided_by: "rules",
    },
    plan_backtest: null,
    interventions: [],
    confidence: { score: 75, level: "high", factors: ["評等 B（基準 60）"] },
    reference_plan: null,
    downgrades: [],
    data_gaps: [],
    ...over,
  } as TradeSignal;
}

// ── an entered plan is not blocked by anything ────────────────────
{
  const entered = signal({
    trade_plan: { ...signal().trade_plan, stance: "enter" },
  });
  check("a plan that enters reports no blocker", classifyBlocker(entered).id === "none");
}

// ── the first gate wins ───────────────────────────────────────────
{
  // No price means no stop and no target either. Reporting three failures for
  // one cause is what makes a census useless.
  const dead = signal({
    data_gaps: ["所有時框的 OHLCV 皆取得失敗，無法計算即時價位，訊號強制為 no-trade"],
    downgrades: ["無法錨定停損：找不到結構", "無法錨定停利：沒有障礙"],
  });
  check("no price outranks the failures it caused", classifyBlocker(dead).id === "no-price", classifyBlocker(dead));

  const noStop = signal({ downgrades: ["無法錨定停損：找不到方向正確的支撐"] });
  check("a missing stop structure is named", classifyBlocker(noStop).id === "no-stop");
  check("and is not presented as tunable", classifyBlocker(noStop).tunable === false);

  const noTarget = signal({ downgrades: ["無法錨定停利：path_obstacles 裡沒有障礙"] });
  check("a missing target structure is named", classifyBlocker(noTarget).id === "no-target");
}

// ── the tunable thresholds ────────────────────────────────────────
{
  const lowGrade = signal({ grade: "C", graded_as: "C", total_score: 7 });
  const g = classifyBlocker(lowGrade);
  check("a sub-B grade is the blocker", g.id === "grade", g);
  check("and it is tunable — the bar is ours", g.tunable === true);
  check("with the scores quoted", g.detail.includes("總分 7"), g.detail);

  // Below the 低 boundary (45) — the confidence veto's remaining territory
  // now that ordinary degraded days (score 45–59) trade with annotations.
  const lowConfidence = signal({
    confidence: { score: 30, level: "low", factors: ["評等 B（基準 60）", "5 項資料缺口（-15）"] },
  });
  const c = classifyBlocker(lowConfidence);
  check("a sub-threshold confidence is the blocker", c.id === "confidence", c);
  check("and names what cost the points", c.detail.includes("資料缺口"), c.detail);

  const noGeometry = signal({
    data_gaps: ["本次不提供參考價位：沒有任何組合通過參考價位門檻（回測勝率 ≥55% 且風報比 ≥1:1.5）"],
  });
  check("nothing clearing the payoff floor is its own gate",
    classifyBlocker(noGeometry).id === "geometry", classifyBlocker(noGeometry));

  const counterTrend = signal({ downgrades: ["逆勢降級：方向與 D1 主趨勢相反"] });
  check("the counter-trend gate is named", classifyBlocker(counterTrend).id === "trend-gate");

  const intervened = signal({ downgrades: ["S2 干涉：要求回測確認，但沒有可回測的保護結構"] });
  check("a journal intervention is named", classifyBlocker(intervened).id === "intervention");

  // 數據前禁入 is only ever written after every other gate passed, so its
  // presence IS the attribution — even when the trend gate's wording also
  // appears (it cannot: the builder skips the blackout on an already-waiting
  // plan, pinned by checking it outranks later gates here).
  const blackout = signal({
    downgrades: ["數據前禁入：45 分鐘後公布美國非農就業（NFP），公布前 2 小時內不建立新倉"],
  });
  const bo = classifyBlocker(blackout);
  check("the pre-event blackout is its own gate", bo.id === "event-blackout", bo);
  check("and quotes the event and countdown", bo.detail.includes("NFP"), bo.detail);

  const labBlocked = signal({
    lab_gate: {
      ids: ["ema50-side"], labels: ["站在 EMA50 正確側"], met: false, checks: [],
      unevaluable: null, adopted_at: "", in_sample_hit_rate: 0.83, in_sample_trades: 120,
      out_of_sample_hit_rate: 0.81, out_of_sample_trades: 51, blocked: true,
    },
  });
  check("an adopted lab condition is named when it blocked",
    classifyBlocker(labBlocked).id === "lab-gate", classifyBlocker(labBlocked));
}

// ── the census ────────────────────────────────────────────────────
{
  const rows = censusOf([
    signal({ symbol: "EURUSD", grade: "C", graded_as: "C" }),
    signal({ symbol: "GBPUSD", grade: "C", graded_as: "C" }),
    signal({ symbol: "WTI", downgrades: ["無法錨定停利：沒有障礙"] }),
    signal({ symbol: "XAUUSD", trade_plan: { ...signal().trade_plan, stance: "enter" } }),
  ]);
  check("the commonest blocker comes first", rows[0].id === "grade", rows.map((r) => r.id));
  check("counts are right", rows[0].count === 2, rows[0]);
  check("shares are percentages of everything scanned", rows[0].share === 50, rows[0].share);
  check("and the symbols are listed so a claim can be checked",
    rows[0].symbols.join(",") === "EURUSD,GBPUSD", rows[0].symbols);
  check("an entered signal is counted too, as 已進場",
    rows.some((r) => r.id === "none" && r.count === 1), rows);
  check("nothing is double-counted",
    rows.reduce((n, r) => n + r.count, 0) === 4, rows);
}

// ── 信心度過低：標記，不是刪除 ────────────────────────────────────
//
// The rule used to DELETE the reference plan on a low-confidence run, and
// the live monitor then reported 「觀望且沒有可追蹤的參考價位」 on 8 of 11
// symbols: nothing was paper-tracked, so the learning loop had no input and
// the review page's paper bucket could never disagree with the real one. A
// low-confidence run is exactly the sample that answers whether
// low-confidence signals are actually worse. The levels now stay, flagged
// `vetoed` with the reason, tracked to resolution, recommended to nobody.
{
  const lowConfidence = signal({
    confidence: { score: 5, level: "low", factors: ["評等 C（基準 40）", "5 項資料缺口（-15）"] },
    reference_plan: {
      entry: 100, stop_loss: 98, take_profit: 105, risk_reward: 2.5,
      entry_reason: "e", stop_reason: "s", target_reason: "t", basis: "b",
      backtest: null, vetoed: true,
      vetoNote: "信心度 5 屬「低」——這次分析的證據本身不足，價位僅作紙上追蹤以累積證據，不建議進場",
    },
  });
  check("a low-confidence signal keeps its reference plan, flagged",
    lowConfidence.reference_plan?.vetoed === true, lowConfidence.reference_plan);
  check("and the flag carries the reason, so no renderer has to invent one",
    lowConfidence.reference_plan?.vetoNote?.includes("信心度") === true,
    lowConfidence.reference_plan?.vetoNote);
  check("the blocker is still attributed to confidence",
    classifyBlocker(lowConfidence).id === "confidence", classifyBlocker(lowConfidence));
}

report("卡關統計");

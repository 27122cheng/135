import { check, report } from "./_harness";
import { entryChecklist, REVIEW_MIN_SAMPLES } from "@/lib/analysis/checklist";
import type { TradeSignal } from "@/types/signal";

/** 進場前七關 — the checklist is computed from the signal, never assumed. */

function signal(over: Partial<TradeSignal> = {}): TradeSignal {
  return {
    symbol: "XAUUSD", direction: "long", generated_at: "2026-11-04T08:00:00.000Z",
    bias_score: 8, entry_structure_score: 5, total_score: 13, grade: "A",
    entry_zone: { low: 2318, high: 2326, reason: "r" },
    stop_loss: { price: 2304, structure: "H4 前低 2308", reason: "r", invalidation: "結構破壞" },
    take_profits: [],
    bias_items: [
      { dimension: "技術面", factor: "D1 EMA 多頭排列", direction: "long", weight: 2, evidence: "e", source: "s" },
      { dimension: "技術面", factor: "W1 週線偏多：價格在週線 EMA20 之上", direction: "long", weight: 1, evidence: "e", source: "s" },
      { dimension: "基本面", factor: "美元走弱", direction: "long", weight: 1, evidence: "e", source: "s" },
      { dimension: "資金流", factor: "VIX 回落", direction: "short", weight: 1, evidence: "e", source: "s" },
    ],
    entry_structures: [{ price: 2322, type: "需求區", role: "support", timeframe: "H4", strength: 3, distance_pct: 0.1 }],
    path_obstacles: [{ price: 2345, type: "前高", timeframe: "H4", strength: 2 }],
    news_digest: null, narrative: "n",
    trade_plan: {
      stance: "enter", entry: 2322, stop_loss: 2304, take_profit: 2362,
      entry_reason: "e", stop_loss_reason: "s", take_profit_reason: "D1 前高", risk_reward: 2.2,
      confidence: "medium", summary: "s", add_ons: [], wait_for: null, decided_by: "ai", entry_style: "confirm",
    },
    thesis: {
      playbook: { regime: "trending", regimeLabel: "趨勢行進中", label: "順勢回踩", entryStyle: "pullback", rationale: "r", maxTargetAtr: 3, fightsRegime: false, fightNote: null, sizeNote: null },
      conditional: [], rawBias: 4, adjustedBias: 4, convictionPenalty: 0,
      invalidations: [{ kind: "price", trigger: "H4 收盤跌破 2304", meaning: "回踩失敗" }],
      reasoning: [],
    },
    plan_backtest: { resolved: 38, wins: 22, losses: 13, timeouts: 3, hitRate: 0.63, expectancyR: 0.42, payoffRatio: 1.6, horizonBars: 20, lookbackBars: 400, hadAmbiguousBars: false, costPct: 0.03 },
    interventions: [], data_gaps: [],
    ...over,
  };
}

{
  const list = entryChecklist(signal());
  check("seven steps, in the checklist's order",
    list.steps.map((s) => s.label).join("") === "背景方向位置觸發失效出場檢討", list.steps.map((s) => s.label));
  check("a complete A-grade plan passes six of seven", list.passed === 6 && list.failed === 0, list.summary);
  const exit = list.steps[5];
  check("the one warning is the obstacle on the way to the target", exit.status === "warn" && exit.note.includes("障礙"), exit);
  check("背景 names the weekly read and the regime", list.steps[0].note.includes("W1") && list.steps[0].note.includes("趨勢行進中"), list.steps[0].note);
  check("方向 names who agrees and who opposes", list.steps[1].note.includes("技術面＋基本面同向") && list.steps[1].note.includes("資金流反向"), list.steps[1].note);
  check("位置 quotes the structure and its distance", list.steps[2].note.includes("需求區") && list.steps[2].note.includes("0.1%"), list.steps[2].note);
  check("觸發 says confirm entry waits for the close", list.steps[3].status === "pass" && list.steps[3].note.includes("收盤"), list.steps[3]);
  check("失效 quotes the stop structure and the invalidation", list.steps[4].note.includes("H4 前低") && list.steps[4].note.includes("反證"), list.steps[4].note);
  check("檢討 reports the backtest with costs", list.steps[6].status === "pass" && list.steps[6].note.includes("已扣成本"), list.steps[6]);
  check("the summary counts", list.summary === "七關 6 過 1 提醒", list.summary);
}

{
  // A bare signal: no thesis, no structures, no backtest, a wait plan.
  const bare = entryChecklist(signal({
    thesis: null, entry_structures: [], path_obstacles: [], plan_backtest: null, reference_plan: null,
    stop_loss: { price: 0, structure: "", reason: "", invalidation: "" },
    trade_plan: { ...signal().trade_plan, stance: "wait", entry: null, stop_loss: null, take_profit: null, wait_for: "等 H4 結構明朗" },
  }));
  check("nothing is assumed: 背景 fails without regime or structures", bare.steps[0].status === "fail", bare.steps[0]);
  check("觸發 shows what it is waiting for", bare.steps[3].status === "warn" && bare.steps[3].note.includes("等 H4 結構明朗"), bare.steps[3]);
  check("失效 fails with neither stop structure nor invalidation", bare.steps[4].status === "fail", bare.steps[4]);
  check("出場 fails with no levels", bare.steps[5].status === "fail");
  check("檢討 fails with no backtest", bare.steps[6].status === "fail" && bare.steps[6].note.includes("沒有回測"));
  check("the summary says so", bare.summary.includes("未過"), bare.summary);
}

{
  const tie = entryChecklist(signal({ direction_tie: true }));
  check("a direction tie fails 方向 outright", tie.steps[1].status === "fail" && tie.steps[1].note.includes("相抵"));
  const fighting = entryChecklist(signal({ thesis: { ...signal().thesis!, playbook: { ...signal().thesis!.playbook, fightsRegime: true, fightNote: "逆著盤整做突破" } } }));
  check("fighting the regime downgrades 方向 to a warning with the note", fighting.steps[1].status === "warn" && fighting.steps[1].note.includes("逆著盤整"), fighting.steps[1]);
  const limit = entryChecklist(signal({ trade_plan: { ...signal().trade_plan, entry_style: "limit" } }));
  check("a limit entry is a warning, not a pass", limit.steps[3].status === "warn" && limit.steps[3].note.includes("限價"), limit.steps[3]);
  const thin = entryChecklist(signal({ plan_backtest: { ...signal().plan_backtest!, resolved: REVIEW_MIN_SAMPLES - 1 } }));
  check("a thin backtest is a hint", thin.steps[6].status === "warn" && thin.steps[6].note.includes("樣本少"), thin.steps[6]);
  const far = entryChecklist(signal({ entry_structures: [{ price: 2290, type: "EMA", role: "support", timeframe: "D1", strength: 1, distance_pct: 1.4 }] }));
  check("a structure too far from the entry only warns", far.steps[2].status === "warn", far.steps[2]);
  // The reference plan gets the same checklist, from its own levels.
  const ref = entryChecklist(signal({
    trade_plan: { ...signal().trade_plan, stance: "wait", entry: null, stop_loss: null, take_profit: null, wait_for: "w" },
    reference_plan: { entry: 2322, stop_loss: 2304, take_profit: 2362, risk_reward: 2.2, entry_reason: "e", stop_reason: "s", target_reason: "D1 前高", basis: "b", backtest: signal().plan_backtest },
  }));
  check("a reference plan's levels are checked the same way", ref.steps[5].note.includes("2362.00") && ref.steps[6].status === "pass", [ref.steps[5], ref.steps[6]]);
}

report("checklist");

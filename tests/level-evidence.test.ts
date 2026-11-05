import { check, report } from "./_harness";
import { levelEvidence } from "@/lib/analysis/level-evidence";
import { buildOrderTicket } from "@/lib/analysis/order-ticket";
import type { TradeSignal } from "@/types/signal";

/** 三個價位各自的證據，以及執行單。 */

function signal(over: Partial<TradeSignal> = {}): TradeSignal {
  return {
    symbol: "XAUUSD", direction: "long", generated_at: "2026-11-04T08:00:00.000Z",
    bias_score: 8, entry_structure_score: 5, total_score: 13, grade: "A",
    entry_zone: { low: 2318, high: 2326, reason: "r" },
    stop_loss: { price: 2304, structure: "H4 前低 2308", reason: "r", invalidation: "結構破壞" },
    take_profits: [], bias_items: [],
    entry_structures: [
      { price: 2322, type: "需求區", role: "support", timeframe: "H4", strength: 3, distance_pct: 0.1 },
      { price: 2311, type: "EMA", role: "support", timeframe: "D1", strength: 2, distance_pct: 0.5 },
    ],
    path_obstacles: [{ price: 2345, type: "前高", timeframe: "H4", strength: 2 }, { price: 2400, type: "週線S/R", timeframe: "W1", strength: 3 }],
    news_digest: null, narrative: "n",
    trade_plan: {
      stance: "enter", entry: 2322, stop_loss: 2304, take_profit: 2362,
      entry_reason: "e", stop_loss_reason: "s", take_profit_reason: "D1 前高", risk_reward: 2.2,
      confidence: "medium", summary: "s", add_ons: [{ sequence: 1, price: 2338, structure: "s", reason: "r", new_stop_loss: 2322, new_stop_reason: "r", locks_in_entry: true }],
      wait_for: null, decided_by: "ai", entry_style: "confirm",
    },
    thesis: {
      playbook: { regime: "trending", regimeLabel: "趨勢行進中", label: "順勢回踩", entryStyle: "pullback", rationale: "r", maxTargetAtr: 3, fightsRegime: false, fightNote: null, sizeNote: null },
      conditional: [], rawBias: 4, adjustedBias: 4, convictionPenalty: 0,
      invalidations: [{ kind: "price", trigger: "H4 收盤跌破 2304", meaning: "回踩失敗" }], reasoning: [],
    },
    plan_backtest: { resolved: 38, wins: 22, losses: 13, timeouts: 3, hitRate: 0.63, expectancyR: 0.42, horizonBars: 20, lookbackBars: 400, hadAmbiguousBars: false, costPct: 0.03 },
    interventions: [{ tag: "S3", effect: "停損加寬至 0.8 ATR", evidence: "近 10 筆 3 筆 S3", triggered_by: [] }],
    order_flow: { timeframe: "H4", source: "volume", bars: 30, lastClv: 0.6, cvdRecent: 0.3, cvdTrend: "up", divergence: null, absorption: { price: 2322, structure: "H4 需求區", role: "support", volRatio: 1.8 }, climax: null, pullbackVolumeRatio: 0.7, trend: "up", lines: [] },
    quant: { bars: 300, atr14: 28, atrPct: 1.2, volPercentile: 60, volLabel: "正常", extensionAtr: 0.4, autocorr1: 0.1, autocorrLabel: "接近隨機", momentum20Pct: 2, momentumPercentile: 70, expectedMove: { bars: 5, price: 62.6, pct: 2.7 }, plan: { targetMoves: 0.64, stopMoves: 0.29, baseRate: 0.41, samples: 290 }, lines: [] },
    data_gaps: [], ...over,
  };
}

{
  const ev = levelEvidence(signal())!;
  check("evidence exists for an entering plan", ev !== null);
  check("entry names the structure, the overlap, the tape and the method",
    ev.entry.some((l) => l.includes("需求區")) && ev.entry.some((l) => l.includes("雙重")) && ev.entry.some((l) => l.includes("吸收")) && ev.entry.some((l) => l.includes("確認進場")), ev.entry);
  check("stop names structure, ATR distance, invalidation and the S3 widening",
    ev.stop.some((l) => l.includes("H4 前低")) && ev.stop.some((l) => l.includes("ATR")) && ev.stop.some((l) => l.includes("反證")) && ev.stop.some((l) => l.includes("停損加寬")), ev.stop);
  check("target counts only obstacles between entry and target", ev.target.some((l) => l.includes("1 個障礙") && l.includes("2345")), ev.target);
  check("target carries the base rate and the backtest", ev.target.some((l) => l.includes("基準率 41%")) && ev.target.some((l) => l.includes("回測：38 筆")), ev.target);
  check("a 2R+ target says scale out", ev.target.some((l) => l.includes("平一半")));
  check("a wait plan has no evidence block", levelEvidence(signal({ trade_plan: { ...signal().trade_plan, stance: "wait", entry: null, stop_loss: null, take_profit: null } })) === null);
  const bare = levelEvidence(signal({ entry_structures: [], order_flow: null, quant: null, interventions: [] }))!;
  check("missing structure is said, not hidden", bare.entry[0].includes("沒有同向結構"), bare.entry);
}

{
  const t = buildOrderTicket(signal())!;
  check("ticket exists", t !== null && t.headline.includes("買進"));
  check("a confirm entry is a market order after the close, not a resting limit", t.lines[0].value.includes("市價") && t.lines[0].note?.includes("不要預掛") === true, t.lines[0]);
  check("stop and target are the closing side", t.lines[1].value.startsWith("賣出 停損 2304.00") && t.lines[2].value.includes("賣出 限價 2362.00"), [t.lines[1], t.lines[2]]);
  check("2R+ target is half size", t.lines[2].value.includes("半倉"));
  check("expiry is 48 hours after the signal", t.validUntil === "2026-11-06T08:00:00.000Z", t.validUntil);
  check("add-ons carry the stop they move to", t.lines.some((l) => l.label === "加倉單" && l.value.includes("2338.00") && l.value.includes("2322.00")));
  check("steps end with the flip exit", t.steps[t.steps.length - 1].includes("結構翻轉"));
  const limit = buildOrderTicket(signal({ direction: "short", trade_plan: { ...signal().trade_plan, entry_style: "limit", entry: 2362, stop_loss: 2380, take_profit: 2322, add_ons: [] } }))!;
  check("a short limit entry sells at the price", limit.lines[0].value === "賣出 限價 2362.00" && limit.lines[1].value.startsWith("買進"), limit.lines.slice(0, 2));
  check("no ticket for a wait plan", buildOrderTicket(signal({ trade_plan: { ...signal().trade_plan, stance: "wait", entry: null, stop_loss: null, take_profit: null } })) === null);
}

report("level-evidence");

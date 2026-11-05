import type { TradeSignal } from "@/types/signal";

/**
 * 三個價位，各自的證據 — why the entry is here, why the stop is there, why
 * the target is that far. Every line quotes a field the signal already
 * carries; nothing is restated as a feeling.
 *
 * The plan card used to show one reason sentence per leg. A trader placing
 * real money wants the stack: the structure under the price, what the tape
 * did there, what the backtest and the base rate say the leg is worth, and
 * which rule moves it afterwards. This assembles that stack so the three
 * legs can be argued with one line at a time.
 */

export interface LevelEvidence {
  entry: string[];
  stop: string[];
  target: string[];
}

const fmt = (n: number) => (Math.abs(n) < 10 ? n.toFixed(4) : n.toFixed(2));
const r2 = (n: number) => Math.round(n * 100) / 100;

export function levelEvidence(signal: TradeSignal): LevelEvidence | null {
  const p = signal.trade_plan;
  if (p.stance !== "enter" || p.entry === null || p.stop_loss === null || p.take_profit === null) return null;
  const dir = signal.direction;
  const entry: string[] = [];
  const stop: string[] = [];
  const target: string[] = [];
  const atr = signal.quant?.atr14 ?? null;
  const of = signal.order_flow ?? null;
  const bt = signal.plan_backtest;

  // 進場
  const structures = [...(signal.entry_structures ?? [])].sort((a, b) => a.distance_pct - b.distance_pct);
  const nearest = structures[0];
  if (nearest) {
    entry.push(`結構：${nearest.timeframe} ${nearest.type} ${fmt(nearest.price)}（距 ${nearest.distance_pct}%，測試 ${nearest.strength} 次）`);
    const second = structures[1];
    if (second && second.distance_pct <= 1.5) entry.push(`疊加：${second.timeframe} ${second.type} ${fmt(second.price)}，雙重支撐／壓力`);
  } else {
    entry.push("結構：沒有同向結構，進場價只是區間中點");
  }
  if (of?.absorption) entry.push(`訂單流：${of.absorption.structure} ${fmt(of.absorption.price)} 出現吸收（${of.absorption.volRatio}× 均量）`);
  if (of?.pullbackVolumeRatio !== null && of?.pullbackVolumeRatio !== undefined && of.pullbackVolumeRatio <= 0.8)
    entry.push(`訂單流：回檔量縮 ${of.pullbackVolumeRatio}×，回踩沒有人反向參與`);
  entry.push(
    p.entry_style === "confirm"
      ? `方式：確認進場（觸及後等 H4 收回再進）${bt ? `，此格局回測 confirm 優於 limit` : ""}`
      : "方式：限價掛單，回踩即成交（此格局回測限價較好）",
  );
  if (signal.lab_gate?.met) entry.push(`實驗室：已採用條件成立（${signal.lab_gate.labels.join("＋")}）`);
  const playbook = signal.thesis?.playbook;
  if (playbook) entry.push(`打法：${playbook.regimeLabel} → ${playbook.label}`);

  // 停損
  const dist = Math.abs(p.entry - p.stop_loss);
  stop.push(`結構：${signal.stop_loss?.structure ? `貼在 ${signal.stop_loss.structure} 之外` : p.stop_loss_reason}`);
  if (atr) stop.push(`距離：${fmt(dist)} = ${r2(dist / atr)} ATR（${r2((dist / p.entry) * 100)}%）`);
  if (signal.stop_loss?.invalidation) stop.push(`失效：${signal.stop_loss.invalidation}`);
  const inv = signal.thesis?.invalidations?.[0];
  if (inv) stop.push(`反證：${inv.trigger} → ${inv.meaning}`);
  const widened = signal.interventions.find((i) => i.tag === "S3");
  if (widened) stop.push(`學習：${widened.effect}（${widened.evidence}）`);
  stop.push("之後：+2R 移到保本；新 swing 形成後移停；事件前 1 小時移到保本");

  // 停利
  const tDist = Math.abs(p.take_profit - p.entry);
  target.push(`結構：${p.take_profit_reason}`);
  const obstacles = (signal.path_obstacles ?? []).filter((o) =>
    dir === "long" ? o.price > p.entry! && o.price < p.take_profit! : o.price < p.entry! && o.price > p.take_profit!,
  );
  target.push(obstacles.length > 0 ? `路上：${obstacles.length} 個障礙（${obstacles.map((o) => fmt(o.price)).join("、")}）` : "路上：進場到目標之間沒有已知障礙");
  if (atr) target.push(`距離：${fmt(tDist)} = ${r2(tDist / atr)} ATR，風報比 1:${p.risk_reward ?? r2(tDist / dist)}`);
  const q = signal.quant?.plan;
  if (q) target.push(`量化：目標 = ${q.targetMoves} 個預期波動${q.baseRate !== null ? `，不挑時機基準率 ${Math.round(q.baseRate * 100)}%` : ""}`);
  if (bt && bt.resolved > 0)
    target.push(`回測：${bt.resolved} 筆，勝率 ${bt.hitRate === null ? "—" : Math.round(bt.hitRate * 100) + "%"}，期望值 ${bt.expectancyR ?? "—"}R${bt.costPct ? `（已扣成本 ${bt.costPct}%）` : ""}`);
  if (dist > 0 && tDist / dist >= 2) target.push("之後：觸及先平一半，剩餘半倉追蹤停損");

  return { entry, stop, target };
}

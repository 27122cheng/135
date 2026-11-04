import type { TradeSignal } from "@/types/signal";

/**
 * 進場前七關 — the pre-entry checklist, computed from the signal itself.
 *
 * The seven steps are the ones a trading-room checklist puts in front of a
 * trader before every order: 背景 → 方向 → 位置 → 觸發 → 失效 → 出場 → 檢討.
 * Every step here is answered from fields the engine already produced —
 * nothing is re-analysed and nothing is invented — so a step that cannot be
 * answered says so instead of passing by default.
 *
 * Three outcomes per step: `pass` (the condition is met and the evidence is
 * named), `warn` (met weakly, or met in a way the reader should know about),
 * `fail` (not met). A plan that stands aside still gets its checklist: the
 * reader should see *which* step kept it out.
 */

export type StepStatus = "pass" | "warn" | "fail";

export interface ChecklistStep {
  /** 1–7. */
  n: number;
  /** 背景 / 方向 / 位置 / 觸發 / 失效 / 出場 / 檢討 */
  label: string;
  /** The question this step answers, in the checklist's own words. */
  question: string;
  status: StepStatus;
  /** The evidence, quoted from the signal. */
  note: string;
}

export interface EntryChecklist {
  steps: ChecklistStep[];
  passed: number;
  warned: number;
  failed: number;
  /** One line: 「七關 5 過 1 提醒 1 未過」. */
  summary: string;
}

/** Structure within this much of the entry counts as "sitting on" it. */
export const ON_STRUCTURE_PCT = 1.0;
/** A backtest below this many resolved samples is a hint, not a record. */
export const REVIEW_MIN_SAMPLES = 20;

const fmt = (n: number) => (Math.abs(n) < 10 ? n.toFixed(4) : n.toFixed(2));

function levelsOf(signal: TradeSignal) {
  const p = signal.trade_plan;
  if (p.stance === "enter" && p.entry !== null && p.stop_loss !== null && p.take_profit !== null) {
    return { entry: p.entry, stop: p.stop_loss, target: p.take_profit, source: "plan" as const };
  }
  const r = signal.reference_plan;
  if (r) return { entry: r.entry, stop: r.stop_loss, target: r.take_profit, source: "reference" as const };
  return null;
}

export function entryChecklist(signal: TradeSignal): EntryChecklist {
  const steps: ChecklistStep[] = [];
  const dir = signal.direction;
  const thesis = signal.thesis ?? null;
  const levels = levelsOf(signal);
  const items = signal.bias_items ?? [];

  // 1. 背景 — which regime, which timeframes, where the key highs and lows are.
  {
    const regime = thesis?.playbook?.regime ?? "unknown";
    const regimeLabel = thesis?.playbook?.regimeLabel ?? "行情性質未判";
    const weekly = items.find((b) => b.factor.startsWith("W1"))?.factor ?? null;
    const marked = (signal.entry_structures?.length ?? 0) + (signal.path_obstacles?.length ?? 0);
    const status: StepStatus = regime === "unknown" ? (marked > 0 ? "warn" : "fail") : "pass";
    steps.push({
      n: 1,
      label: "背景",
      question: "持倉週期、趨勢還是區間、重要高低點",
      status,
      note:
        `H4 進場／D1 背景${weekly ? `／${weekly.split("：")[0]}` : ""}；${regimeLabel}` +
        (marked > 0 ? `；已標 ${marked} 個高低點與結構` : "；尚未標出高低點"),
    });
  }

  // 2. 方向 — do the dimensions agree, and does the direction fight the regime?
  {
    const dims = new Map<string, "long" | "short" | "mixed">();
    for (const b of items) {
      if (b.weight === 0 || b.direction === "neutral") continue;
      const prev = dims.get(b.dimension);
      dims.set(b.dimension, prev === undefined || prev === b.direction ? b.direction : "mixed");
    }
    const agree = [...dims.entries()].filter(([, d]) => d === dir).map(([k]) => k);
    const oppose = [...dims.entries()].filter(([, d]) => d !== dir && d !== "mixed").map(([k]) => k);
    const fights = thesis?.playbook?.fightsRegime === true;
    const status: StepStatus = signal.direction_tie
      ? "fail"
      : agree.length >= 2 && !fights && oppose.length < agree.length
        ? "pass"
        : agree.length >= 1
          ? "warn"
          : "fail";
    steps.push({
      n: 2,
      label: "方向",
      question: "各面向是否同向，有沒有逆著行情性質",
      status,
      note: signal.direction_tie
        ? "多空因子相抵，沒有方向"
        : `${agree.length > 0 ? agree.join("＋") + "同向" : "無面向同向"}` +
          (oppose.length > 0 ? `；${oppose.join("、")}反向` : "") +
          (fights ? `；${thesis?.playbook?.fightNote ?? "方向逆著行情性質"}` : "") +
          "；同一事實只算一票",
    });
  }

  // 3. 位置 — does the entry sit on a real structure, or chase?
  {
    const structures = signal.entry_structures ?? [];
    const nearest = structures.length > 0 ? Math.min(...structures.map((s) => s.distance_pct)) : null;
    const on = structures.filter((s) => s.distance_pct <= ON_STRUCTURE_PCT);
    const style = thesis?.playbook?.entryStyle ?? null;
    const status: StepStatus =
      levels === null
        ? structures.length > 0 ? "warn" : "fail"
        : on.length > 0 && style !== "fade"
          ? "pass"
          : structures.length > 0
            ? "warn"
            : "fail";
    const best = on.sort((a, b) => b.strength - a.strength)[0] ?? structures[0];
    steps.push({
      n: 3,
      label: "位置",
      question: "進場是否貼著結構，不追價",
      status,
      note:
        (levels ? `進場 ${fmt(levels.entry)}` : "尚無進場價") +
        (best
          ? `，${best.timeframe} ${best.type} ${fmt(best.price)}（距 ${nearest}%，測試 ${best.strength} 次）`
          : "，沒有同向結構可依") +
        (style === "pullback" ? "；回踩打法" : style === "fade" ? "；逆勢打法，位置要更嚴" : ""),
    });
  }

  // 4. 觸發 — what has to happen before the order goes in.
  {
    const p = signal.trade_plan;
    const confirmed = (signal.chart_patterns ?? []).find((c) => c.status === "confirmed" && c.direction === dir);
    if (p.stance !== "enter") {
      steps.push({
        n: 4,
        label: "觸發",
        question: "預先定義的 K 棒或結構條件",
        status: "warn",
        note: p.wait_for ? `觀望，等：${p.wait_for}` : "觀望，尚無觸發條件",
      });
    } else {
      const confirm = p.entry_style === "confirm";
      steps.push({
        n: 4,
        label: "觸發",
        question: "預先定義的 K 棒或結構條件",
        status: confirm || confirmed ? "pass" : "warn",
        note:
          (confirm
            ? "確認進場：觸及後等一根 H4 收盤站回同側才成交"
            : "限價進場：回踩即成交（此格局回測顯示限價較好）") +
          (confirmed ? `；${confirmed.name} 已確認（突破、量能、回測三關過）` : "") +
          "；建議發出後 60 秒內不進場",
      });
    }
  }

  // 5. 失效 — is the stop where the idea dies, and is that written down?
  {
    const stopStructure = signal.stop_loss?.structure?.trim() ?? "";
    const invalidations = thesis?.invalidations ?? [];
    const status: StepStatus =
      stopStructure && invalidations.length > 0 ? "pass" : stopStructure || invalidations.length > 0 ? "warn" : "fail";
    const price = levels ? `停損 ${fmt(levels.stop)}` : "尚無停損";
    const lead = invalidations[0];
    steps.push({
      n: 5,
      label: "失效",
      question: "停損放在理由失效處，失效條件先寫好",
      status,
      note:
        `${price}${stopStructure ? `，貼在 ${stopStructure} 之外` : "，未貼結構"}` +
        (lead ? `；反證：${lead.trigger} → ${lead.meaning}` : "；沒有寫下反證條件") +
        (invalidations.length > 1 ? `（共 ${invalidations.length} 條）` : ""),
    });
  }

  // 6. 出場 — target on real resistance, rules decided in advance, horizons apart.
  {
    const p = signal.trade_plan;
    const reason = (p.stance === "enter" ? p.take_profit_reason : signal.reference_plan?.target_reason ?? "").trim();
    const obstacles = signal.path_obstacles ?? [];
    const inPath =
      levels === null
        ? []
        : obstacles.filter((o) => (dir === "long" ? o.price > levels.entry && o.price < levels.target : o.price < levels.entry && o.price > levels.target));
    const status: StepStatus = levels === null ? "fail" : reason ? (inPath.length > 0 ? "warn" : "pass") : "warn";
    steps.push({
      n: 6,
      label: "出場",
      question: "目標顧到前方阻力，出場規則事先定",
      status,
      note:
        (levels ? `目標 ${fmt(levels.target)}${reason ? `（${reason}）` : ""}` : "尚無目標") +
        (inPath.length > 0 ? `；路上還有 ${inPath.length} 個障礙，先看能否過` : "") +
        "；固定目標＋結構翻轉／論點失效提早出場" +
        (p.swing ? "；波段另列，與當沖分開" : ""),
    });
  }

  // 7. 檢討 — was this geometry tested with costs, and what does the book say here?
  {
    const bt = signal.plan_backtest ?? signal.reference_plan?.backtest ?? null;
    const ctx = signal.context_record;
    const status: StepStatus =
      bt === null ? "fail" : bt.resolved >= REVIEW_MIN_SAMPLES && (bt.costPct ?? 0) > 0 ? "pass" : "warn";
    steps.push({
      n: 7,
      label: "檢討",
      question: "勝率、平均盈虧、回撤、成本一起看",
      status,
      note: bt
        ? `回測 ${bt.resolved} 筆：勝率 ${bt.hitRate === null ? "—" : Math.round(bt.hitRate * 100) + "%"}` +
          `，期望值 ${bt.expectancyR === null ? "—" : bt.expectancyR + "R"}` +
          (bt.payoffRatio != null ? `，賠率 ${bt.payoffRatio}` : "") +
          (bt.costPct ? `，已扣成本 ${bt.costPct}%` : "，未計成本") +
          (bt.resolved < REVIEW_MIN_SAMPLES ? "（樣本少，只能當提示）" : "") +
          (ctx && ctx.lines.length > 0 ? `；同情境實績：${ctx.lines[0]}` : "")
        : "沒有回測：這組價位沒有被歷史檢驗過",
    });
  }

  const passed = steps.filter((s) => s.status === "pass").length;
  const warned = steps.filter((s) => s.status === "warn").length;
  const failed = steps.filter((s) => s.status === "fail").length;
  return {
    steps,
    passed,
    warned,
    failed,
    summary: `七關 ${passed} 過${warned > 0 ? ` ${warned} 提醒` : ""}${failed > 0 ? ` ${failed} 未過` : ""}`,
  };
}

import type { TradeSignal } from "@/types/signal";
import { CONFIDENT_ENTRY_MIN, clearsEntryBar } from "./confidence";

/**
 * 卡在哪一關 — which gate actually stopped this signal.
 *
 * ## Why this exists
 *
 * "訊號太少" and "勝率太低" are the two complaints that cannot both be fixed by
 * moving a threshold: loosening raises volume and lowers the hit rate, and
 * tightening does the reverse. The only way out is to find the gate that is
 * doing the *wrong* rejecting — turning away setups that would have worked —
 * and that requires knowing which gate is doing the rejecting at all.
 *
 * Until now nobody could say. Nine symbols came back 觀望 with nine different
 * paragraphs, and whether that was the grade, the confidence bar, a missing
 * take-profit structure or the counter-trend rule was a question you answered
 * by reading nine cards and guessing. This classifies each one, so a week of
 * scans becomes a distribution: "62% 卡在找不到停利結構" is an engineering
 * task, while "訊號太少" is a mood.
 *
 * ## Derived, not instrumented
 *
 * Everything here is read off the finished signal. Threading a "blocked by"
 * field through the builder would mean touching every gate and keeping them in
 * sync forever; the signal already carries the evidence, and a pure function
 * over it can be tested against fixtures and applied retroactively to rows
 * written months ago.
 *
 * ## First gate wins
 *
 * The order below is the pipeline's own order. A signal with no price also has
 * no stop and no target, and reporting all three would triple-count one
 * failure — the earliest gate is the one to fix.
 */

export type BlockerId =
  | "none"
  | "no-price"
  | "no-stop"
  | "no-target"
  | "grade"
  | "trend-gate"
  | "intervention"
  | "lab-gate"
  | "event-blackout"
  | "confidence"
  | "geometry"
  | "plan-judgement";

export interface Blocker {
  id: BlockerId;
  /** Short label for a table cell. */
  label: string;
  /** The specific reason on this signal, quoted from its own text. */
  detail: string;
  /**
   * Whether this gate is a threshold someone could reasonably tune, versus a
   * fact about the market. Tuning "找不到停利結構" is not on the table; the
   * structure genuinely was not there.
   */
  tunable: boolean;
}

const GRADE_ORDER = ["no-trade", "C", "B", "A", "A+"];

function has(list: string[] | undefined, pattern: RegExp): string | null {
  return list?.find((s) => pattern.test(s)) ?? null;
}

export function classifyBlocker(signal: TradeSignal): Blocker {
  const gaps = signal.data_gaps ?? [];
  const downgrades = signal.downgrades ?? [];

  if (signal.trade_plan?.stance === "enter") {
    return { id: "none", label: "已進場", detail: "通過所有關卡", tunable: false };
  }

  const noPrice = has(gaps, /所有時框的 OHLCV 皆取得失敗|無價格資料/);
  if (noPrice) {
    return { id: "no-price", label: "沒有價格", detail: noPrice, tunable: false };
  }

  const noStop = has(downgrades, /無法錨定停損/) ?? has(gaps, /無法錨定有效停損結構/);
  if (noStop) {
    return { id: "no-stop", label: "找不到停損結構", detail: noStop, tunable: false };
  }

  const noTarget = has(downgrades, /無法錨定停利/) ?? has(gaps, /找不到方向正確的停利價位/);
  if (noTarget) {
    return { id: "no-target", label: "找不到停利結構", detail: noTarget, tunable: false };
  }

  // 數據前禁入 is applied *last* in the builder and only to a plan that had
  // already cleared every other gate, so when its note is present it is by
  // construction the gate that withdrew the trade — checked early here so the
  // census never books a blackout day against the grade or the confidence bar.
  const blackout = has(downgrades, /數據前禁入/);
  if (blackout) {
    return { id: "event-blackout", label: "數據前禁入窗", detail: blackout, tunable: true };
  }

  const trend = has(downgrades, /逆勢/);
  if (trend) {
    return { id: "trend-gate", label: "逆勢閘門", detail: trend, tunable: true };
  }

  const intervention = has(downgrades, /干涉/);
  if (intervention) {
    return { id: "intervention", label: "停損復盤干涉", detail: intervention, tunable: true };
  }

  if (signal.lab_gate?.blocked) {
    return {
      id: "lab-gate",
      label: "實驗室條件未成立",
      detail: signal.lab_gate.labels.join(" ＋ "),
      tunable: true,
    };
  }

  // The grade bar, read from the score rather than from prose: a signal whose
  // own scoring table put it below B never reached the later gates at all.
  const grade = signal.graded_as ?? signal.grade;
  if (GRADE_ORDER.indexOf(grade) < GRADE_ORDER.indexOf("B")) {
    return {
      id: "grade",
      label: "評等未達 B",
      detail: `評等 ${grade}（方向分 ${signal.bias_score}、結構分 ${signal.entry_structure_score}、總分 ${signal.total_score}）`,
      tunable: true,
    };
  }

  const confidence = signal.confidence?.score;
  if (confidence !== undefined && !clearsEntryBar(confidence)) {
    return {
      id: "confidence",
      label: "信心度未達門檻",
      detail: `信心度 ${confidence}，門檻 ${CONFIDENT_ENTRY_MIN}：${
        signal.confidence?.factors.slice(1).join("；") || "評等基準本身不足"
      }`,
      tunable: true,
    };
  }

  // Graded well enough, confident enough, and still no plan: no combination of
  // the available levels cleared the hit-rate floor or the payoff floor. This
  // is the gate that produces "分析看起來很好但沒有訊號", and it is tunable —
  // the floors are numbers this system chose.
  const geometry =
    has(gaps, /沒有任何組合通過/) ??
    has(gaps, /回測勝率|風報比/) ??
    (signal.reference_plan === null ? "沒有任何進出場組合通過回測勝率與風報比門檻" : null);
  if (geometry) {
    return { id: "geometry", label: "價位組合未過門檻", detail: geometry, tunable: true };
  }

  return {
    id: "plan-judgement",
    label: "計畫判定觀望",
    detail: signal.trade_plan?.wait_for || signal.trade_plan?.summary || "計畫選擇觀望",
    tunable: true,
  };
}

export interface BlockerCensus {
  id: BlockerId;
  label: string;
  count: number;
  share: number;
  tunable: boolean;
  /** The symbols this gate stopped, so a claim can be checked case by case. */
  symbols: string[];
}

/** The distribution across a set of signals, commonest first. */
export function censusOf(signals: TradeSignal[]): BlockerCensus[] {
  const byId = new Map<BlockerId, BlockerCensus>();
  for (const signal of signals) {
    const blocker = classifyBlocker(signal);
    const row = byId.get(blocker.id) ?? {
      id: blocker.id,
      label: blocker.label,
      count: 0,
      share: 0,
      tunable: blocker.tunable,
      symbols: [],
    };
    row.count++;
    if (!row.symbols.includes(signal.symbol)) row.symbols.push(signal.symbol);
    byId.set(blocker.id, row);
  }
  const total = signals.length || 1;
  return [...byId.values()]
    .map((r) => ({ ...r, share: Math.round((r.count / total) * 1000) / 10 }))
    .sort((a, b) => b.count - a.count);
}

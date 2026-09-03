import { completeAI, jsonSchema } from "@/lib/ai";
import {
  PREVENTABLE_TAGS,
  STOP_REASON_LABELS,
  STOP_REASON_TAGS,
  type StopReasonTag,
} from "@/types/journal";
import type { SignalRow } from "@/types/signal";

/**
 * 停損復盤 — why the stop was hit, and therefore what to tighten next time.
 *
 * ## The loop this closes
 *
 * The intervention engine has always been able to change how signals are
 * built — narrower entry zones, wider stop buffers, higher bias thresholds,
 * outright no-trade when the macro read disagrees. What it needed was reviewed
 * losses to learn from, and those only ever arrived by hand. Nobody hand-writes
 * a post-mortem for every stop-out, so `computeInterventions` has spent its
 * whole life reading an empty table and returning the defaults.
 *
 * This writes the review automatically the moment a tracked plan stops out. The
 * classification feeds `severity`, severity feeds the intervention rules, and
 * the rules feed the next signal. 止損 → 審查 → 改變之後的交易模式.
 *
 * ## The AI classifies; it does not decide
 *
 * The model picks **an index into `STOP_REASON_TAGS`** — never a tag string,
 * never a severity, never an intervention. Same constraint as the trade plan's
 * price indices, and for the same reason: what the model is good at here is
 * reading a situation and matching it to a category, and everything downstream
 * of that category is arithmetic that has to be reproducible.
 *
 * ## It must work with no AI at all
 *
 * The free tiers are exhausted most days. A review step that only runs when a
 * model answers is a review step that never runs, and then the loop is
 * decorative. So the deterministic classifier below is the default path, not
 * the emergency one: it reads the same evidence and reaches a defensible tag on
 * its own. The AI is asked to *revise* that verdict when it is available, and
 * the review records which one decided.
 */

/** Everything the classifier gets to look at. All of it is already stored. */
export interface StopContext {
  signal: SignalRow;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  /** Price that triggered the stop. */
  exitPrice: number;
  /**
   * Best price seen in the trade's favour before the stop, if the monitor
   * recorded one. Null when the trade was never tracked far enough to know.
   */
  bestPrice: number | null;
  /** True when a high-impact release landed while the position was open. */
  eventDuringHold: boolean;
}

export interface StopReview {
  tag: StopReasonTag;
  note: string;
  decidedBy: "ai" | "rules";
}

/** How far the trade went in your favour, as a fraction of the risk taken. */
function favourableExcursionR(ctx: StopContext): number | null {
  if (ctx.bestPrice === null) return null;
  const risk = Math.abs(ctx.entry - ctx.stopLoss);
  if (!(risk > 0)) return null;
  const move =
    ctx.signal.direction === "long" ? ctx.bestPrice - ctx.entry : ctx.entry - ctx.bestPrice;
  return Math.round((move / risk) * 100) / 100;
}

/** Whether the entry was taken at market rather than on a pullback structure. */
function enteredAtMarket(ctx: StopContext): boolean {
  return (ctx.signal.trade_plan?.entry_reason ?? "").includes("現價進場");
}

function netOfDimension(ctx: StopContext, dimension: string): number {
  return (ctx.signal.bias_items ?? [])
    .filter((b) => b.dimension === dimension)
    .reduce((sum, b) => {
      if (b.direction === "long") return sum + b.weight;
      if (b.direction === "short") return sum - b.weight;
      return sum;
    }, 0);
}

/**
 * The verdict the evidence supports on its own.
 *
 * Ordered by how specific the claim is: a rule that can point at a concrete
 * fact (a release landed, the macro read was opposite, the trade never went
 * your way at all) is checked before the ones that are really "nothing else
 * fits". The last branch is S1 rather than a shrug because "the direction was
 * wrong" is the honest default when a trade goes straight to its stop and no
 * more specific story is available.
 *
 * S5 (execution) and S6 (discipline) are deliberately unreachable here. Both
 * are about what happened between the plan and the fill, and this system never
 * sees a fill — it watches a price series. Assigning them from price alone
 * would be inventing a fact about the trader.
 */
export function classifyByRules(ctx: StopContext): { tag: StopReasonTag; note: string } {
  const mfe = favourableExcursionR(ctx);
  const direction = ctx.signal.direction;

  if (ctx.eventDuringHold) {
    return {
      tag: "S4",
      note: "持倉期間有高影響力數據公布，價格被事件推離計畫，屬事件衝擊。",
    };
  }

  // The macro read pointed the other way and we traded anyway.
  const macro = netOfDimension(ctx, "基本面");
  if (macro !== 0 && (macro > 0) !== (direction === "long")) {
    return {
      tag: "S7",
      note: `基本面淨方向為 ${macro > 0 ? "多" : "空"}，與訊號方向相反，總經判斷錯誤。`,
    };
  }

  const positioning = netOfDimension(ctx, "籌碼面");
  if (positioning !== 0 && (positioning > 0) !== (direction === "long")) {
    return {
      tag: "S8",
      note: `籌碼面淨方向為 ${positioning > 0 ? "多" : "空"}，與訊號方向相反，COT／未平倉訊號被忽略。`,
    };
  }

  if (mfe !== null && mfe >= 1) {
    // It reached a full R in your favour and still came back through the stop.
    // That is not a bad direction call — the level was simply too close to the
    // noise for the move it was trying to hold.
    return {
      tag: "S3",
      note: `最大順向幅度達 ${mfe}R 後才回頭觸及停損，方向抓對但停損距離不足以容納回檔。`,
    };
  }

  if (mfe !== null && mfe <= 0.1 && enteredAtMarket(ctx)) {
    return {
      tag: "S2",
      note: `以現價進場且最大順向幅度僅 ${mfe}R，等同追價，沒有等到回測就進場。`,
    };
  }

  // 方向有走、沒走遠 — the band the old rules got wrong.
  //
  // Anything under 1R fell through to S1（方向錯）, and S1's intervention
  // raises the bias threshold: a trade that went +0.6R in our favour and then
  // reversed through the stop was teaching the system that its DIRECTION
  // calls were bad. They were not — the market agreed for a while. What
  // failed was timing or location: a deeper entry would have carried the same
  // move at less risk, or would not have filled at all. That is S2's lesson
  // (narrower zone, wait for confirmation), and S2 is where it goes. The
  // boundary is 0.3R: below it the trade never really went our way and S1's
  // reading is the honest one.
  if (mfe !== null && mfe > S1_MAX_MFE_R && mfe < 1) {
    return {
      tag: "S2",
      note:
        `最大順向幅度 ${mfe}R —— 方向曾被市場認同，但走不到 1R 就反轉穿過停損。` +
        `這不是方向錯，是進場時機／位置：更深的回測會用更少的風險換到同一段行情，或根本不會成交。`,
    };
  }

  return {
    tag: "S1",
    note:
      mfe === null
        ? "沒有記錄到順向幅度，價格直接走向停損，最可能是方向判斷本身錯誤。"
        : `最大順向幅度僅 ${mfe}R，價格幾乎沒有往計畫方向走，屬結構誤判。`,
  };
}

/**
 * Below this favourable excursion the trade never went our way and the loss
 * is a direction call (S1); above it the direction had merit and the loss is
 * timing or location (S2), up to the 1R at which it becomes stop sizing (S3).
 */
export const S1_MAX_MFE_R = 0.3;

interface AiVerdict {
  tag_index?: number;
  note?: string;
}

const REVIEW_SCHEMA = jsonSchema<AiVerdict>(
  "stop-review",
  `輸出嚴格的 JSON（不要 markdown code fence、不要其他文字）：\n` +
    `{"tag_index": number, "note": string}\n` +
    `tag_index 必須是下方分類清單的編號。note 用一句繁體中文說明理由，60 字內。`,
  (v) => (typeof v.tag_index === "number" ? (v as AiVerdict) : null),
);

function buildPrompt(ctx: StopContext, baseline: { tag: StopReasonTag; note: string }): string {
  const mfe = favourableExcursionR(ctx);
  const s = ctx.signal;
  const heaviest = (s.bias_items ?? [])
    .filter((b) => b.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 8)
    .map((b) => `  - [${b.dimension}/${b.direction}/權重${b.weight}] ${b.factor}`)
    .join("\n");

  return (
    `一筆交易觸及停損，請判斷最主要的原因屬於哪一類。\n\n` +
    `商品 ${s.symbol}，方向 ${s.direction === "long" ? "做多" : "做空"}，評等 ${s.grade}\n` +
    `進場 ${ctx.entry}、停損 ${ctx.stopLoss}、停利 ${ctx.takeProfit}、出場 ${ctx.exitPrice}\n` +
    `最大順向幅度 ${mfe === null ? "未記錄" : `${mfe}R`}\n` +
    `進場理由：${s.trade_plan?.entry_reason ?? "—"}\n` +
    `停損理由：${s.trade_plan?.stop_loss_reason ?? "—"}\n` +
    `持倉期間有高影響力數據：${ctx.eventDuringHold ? "是" : "否"}\n` +
    `本次資料缺口 ${s.data_gaps?.length ?? 0} 項\n\n` +
    `當時的主要因子：\n${heaviest || "  （無）"}\n\n` +
    `分類清單：\n` +
    STOP_REASON_TAGS.map((t, i) => `  [${i}] ${t} ${STOP_REASON_LABELS[t]}`).join("\n") +
    `\n\n規則判斷的結果是 [${STOP_REASON_TAGS.indexOf(baseline.tag)}] ${baseline.tag}：${baseline.note}\n` +
    `如果你同意就沿用，不同意才改。\n` +
    `嚴格規則：只能選編號，只准根據以上資料推論，不准補充未提供的事實。\n` +
    `注意：S5（執行問題）與 S6（紀律問題）需要成交紀錄才能判斷，本系統只看價格序列，` +
    `除非上面的資料直接指出，否則不要選這兩項。`
  );
}

/**
 * Classifies a stop-out, preferring the model's read when one is available.
 *
 * Never throws and never returns null: a review that can fail is a review the
 * caller has to have a policy for, and the only sane policy is the rules
 * verdict — which is already computed before the model is asked.
 */
export async function reviewStop(ctx: StopContext, gaps: string[]): Promise<StopReview> {
  const baseline = classifyByRules(ctx);

  const result = await completeAI(buildPrompt(ctx, baseline), REVIEW_SCHEMA, gaps, {
    maxTokens: 300,
  }).catch(() => null);

  const index = result?.value.tag_index;
  if (
    typeof index !== "number" ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= STOP_REASON_TAGS.length
  ) {
    return { ...baseline, decidedBy: "rules" };
  }

  const tag = STOP_REASON_TAGS[index];
  // The model is not allowed to reach for the two tags this system has no
  // evidence for. Letting it would put an unfalsifiable "you didn't follow the
  // rules" on a trade nobody placed.
  if ((tag === "S5" || tag === "S6") && baseline.tag !== tag) {
    return {
      ...baseline,
      decidedBy: "rules",
      note: `${baseline.note}（AI 判為 ${tag}，但本系統只看價格序列、無成交紀錄，不採信該分類）`,
    };
  }

  return {
    tag,
    note: result?.value.note?.trim() || STOP_REASON_LABELS[tag],
    decidedBy: "ai",
  };
}

/** What the review will change, in words — shown with the entry. */
export function describeConsequence(tag: StopReasonTag): string {
  const preventable = PREVENTABLE_TAGS[tag] ? "可事前預防" : "事前難以避免";
  const effect: Record<StopReasonTag, string> = {
    S1: "累積後會提高 bias_score 門檻，方向證據不夠強就不給同等級",
    S2: "累積後會收窄進場區間，並強制要求回測確認才進場",
    S3: "累積後會加大停損的 ATR buffer，讓停損離結構更遠",
    S4: "累積後會在 24 小時內有高影響力數據時降一級",
    S5: "本系統無成交紀錄，不會自動觸發干涉",
    S6: "本系統無成交紀錄，不會自動觸發干涉",
    S7: "累積後會在基本面方向相反時直接 no-trade",
    S8: "累積後會在 COT 極端且方向相反時直接 no-trade",
  };
  return `${preventable}。${effect[tag]}。`;
}

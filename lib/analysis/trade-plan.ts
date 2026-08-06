import { completeAI, jsonSchema } from "@/lib/ai";
import type { BiasItem, Grade, TradePlan, TradeSignal } from "@/types/signal";
import { MIN_ENTRY_GRADE, gradeAllowsEntry } from "@/lib/scoring";

interface Candidate {
  price: number;
  label: string;
}

export interface TradePlanInput {
  symbol: string;
  direction: "long" | "short";
  grade: Grade;
  bias_score: number;
  entry_structure_score: number;
  total_score: number;
  bias_items: BiasItem[];
  entryCandidates: Candidate[];
  slCandidates: Candidate[];
  tpCandidates: Candidate[];
  narrative: string;
  /** data_gaps so far — the AI should weigh missing evidence when deciding. */
  knownGaps: string[];
  /**
   * True when the hard scoring rules already returned no-trade. The AI may
   * still explain and say what to wait for, but must not turn it into an entry.
   */
  gradeForcesWait: boolean;
}

function round(n: number): number {
  return Math.round(n * 100000) / 100000;
}

function riskReward(
  direction: "long" | "short",
  entry: number,
  sl: number,
  tp: number,
): number | null {
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  if (risk <= 0) return null;
  // Sanity: the stop must sit on the losing side and the target on the winning side.
  const stopOk = direction === "long" ? sl < entry : sl > entry;
  const targetOk = direction === "long" ? tp > entry : tp < entry;
  if (!stopOk || !targetOk) return null;
  return Math.round((reward / risk) * 100) / 100;
}


/**
 * A trade that risks more than it stands to make isn't worth taking.
 * Named because two code paths enforce it and they must not drift.
 */
const MIN_RISK_REWARD = 1;

/** Prompt size caps — see buildPrompt for why each is where it is. */
const MAX_CANDIDATES = 6;
const MAX_BIAS_ITEMS = 8;
const MAX_NARRATIVE_CHARS = 300;

interface StanceVerdict {
  stance: "enter" | "wait";
  summary: string;
  waitFor: string | null;
}

/**
 * Whether to trade at all — decided by the scoring rules, never by the model.
 *
 * The AI used to return `stance`, which meant the same score could produce
 * 進場 on one run and 觀望 on the next: the board showed a full set of levels
 * for SPX500 while the detail page, built a minute later from identical
 * inputs, said 觀望. Both were "real"; neither was reproducible.
 *
 * Making the model deterministic is not on the menu. Taking the decision away
 * from it is. What the AI still does — choose which of the listed structures to
 * use, and write the reasons — is judgement over a fixed menu, and a different
 * choice there changes the levels, not whether you are in the market.
 *
 * Pure and synchronous, so the rule is testable without a model or a network.
 */
export function decideStance(input: TradePlanInput): StanceVerdict {
  if (input.gradeForcesWait || !gradeAllowsEntry(input.grade)) {
    return {
      stance: "wait",
      summary:
        `評等 ${input.grade}（方向分 ${input.bias_score}、結構分 ${input.entry_structure_score}、` +
        `總分 ${input.total_score}）未達可進場門檻 ${MIN_ENTRY_GRADE}，依計分規則觀望。`,
      waitFor: `等待評等升到 ${MIN_ENTRY_GRADE} 以上 —— 需要更多面向同向，或價格回測到更強的結構。`,
    };
  }

  if (
    input.entryCandidates.length === 0 ||
    input.slCandidates.length === 0 ||
    input.tpCandidates.length === 0
  ) {
    return {
      stance: "wait",
      summary: "沒有足夠的真實結構可以組成進場／停損／停利，依規則觀望。",
      waitFor: "等待價格接近有效的支撐／壓力結構。",
    };
  }

  // Every listed combination loses on geometry alone. Checking all of them
  // rather than the first triple: the AI is about to pick from this menu, and
  // refusing here on the default choice while a workable pair exists would
  // stand aside from a trade the rules actually permit.
  const anyWorkable = input.entryCandidates.some((entry) =>
    input.slCandidates.some((sl) =>
      input.tpCandidates.some((tp) => {
        const rr = riskReward(input.direction, entry.price, sl.price, tp.price);
        return rr !== null && rr >= MIN_RISK_REWARD;
      }),
    ),
  );
  if (!anyWorkable) {
    return {
      stance: "wait",
      summary: `現有結構的任何組合風險報酬比都低於 1:${MIN_RISK_REWARD}，賠率不划算，依規則觀望。`,
      waitFor: "等待價格回落到更好的進場位置，或等更遠的停利結構出現。",
    };
  }

  return { stance: "enter", summary: "", waitFor: null };
}

function waitPlan(
  summary: string,
  waitFor: string | null,
  decidedBy: "ai" | "fallback",
): TradePlan {
  return {
    stance: "wait",
    entry: null,
    stop_loss: null,
    take_profit: null,
    entry_reason: "—",
    stop_loss_reason: "—",
    take_profit_reason: "—",
    risk_reward: null,
    confidence: "low",
    summary,
    add_ons: [],
    wait_for: waitFor,
    decided_by: decidedBy,
  };
}

/** Deterministic choice used when the AI is unavailable or returns anything invalid. */
function fallbackPlan(input: TradePlanInput): TradePlan {
  if (input.gradeForcesWait) {
    return waitPlan(
      `評等為 no-trade（方向分 ${input.bias_score}、結構分 ${input.entry_structure_score}、總分 ${input.total_score}），依硬性規則不進場。`,
      "等待評等回到 C 以上，或等價格回測到有效結構再重新評估。",
      "fallback",
    );
  }
  // Search the menu instead of taking the first of each list.
  //
  // The old version used index 0 throughout, which meant the *nearest* target —
  // systematically the worst payoff on offer. That mattered more than it looks:
  // a fallback plan is penalised in the confidence score for not having been
  // chosen by a model, and it was earning that penalty partly by making a
  // choice nobody would defend. Picking the best available combination is what
  // makes the penalty about missing judgement rather than about bad arithmetic.
  let entry: Candidate | undefined;
  let sl: Candidate | undefined;
  let tp: Candidate | undefined;
  let rr = 0;
  for (const e of input.entryCandidates) {
    for (const s of input.slCandidates) {
      for (const t of input.tpCandidates) {
        const candidateRr = riskReward(input.direction, e.price, s.price, t.price);
        if (candidateRr === null || candidateRr < MIN_RISK_REWARD) continue;
        // Strictly greater, so an equal payoff keeps the earlier — and
        // therefore nearer — entry. Without that tie-break the search drifts
        // toward the furthest pullback for free, since a more distant entry
        // mechanically improves the ratio.
        if (candidateRr > rr) {
          entry = e;
          sl = s;
          tp = t;
          rr = candidateRr;
        }
      }
    }
  }

  if (!entry || !sl || !tp) {
    // Either there were no candidates at all, or every combination lost on
    // geometry. decideStance already refuses the second case before the AI is
    // called, so reaching here means the lists themselves were empty.
    return waitPlan(
      input.entryCandidates.length === 0 ||
        input.slCandidates.length === 0 ||
        input.tpCandidates.length === 0
        ? "缺少可用的進場、停損或停利結構，無法組成計畫。"
        : `現有結構的任何組合風險報酬比都低於 1:${MIN_RISK_REWARD}，賠率不划算，建議觀望。`,
      "等待價格接近有效的支撐／壓力結構，或等更遠的停利結構出現。",
      "fallback",
    );
  }
  return {
    stance: "enter",
    entry: round(entry.price),
    stop_loss: round(sl.price),
    take_profit: round(tp.price),
    entry_reason: entry.label,
    stop_loss_reason: sl.label,
    take_profit_reason: tp.label,
    risk_reward: rr,
    confidence: input.grade === "A+" || input.grade === "A" ? "medium" : "low",
    summary:
      "未使用 AI 判斷（未設定 AI 金鑰、額度用盡或呼叫失敗），改用預設規則：" +
      `在所有真實結構的組合中，選出風險報酬比最佳且不低於 1:${MIN_RISK_REWARD} 的一組（本組 1:${rr}）。`,
    add_ons: [],
    wait_for: null,
    decided_by: "fallback",
  };
}

/**
 * Everything the model needs to pick levels, and nothing else.
 *
 * Rewritten after `stance` became deterministic. The old version spent a third
 * of its length arguing the case for standing aside — instructions for a
 * decision the model is no longer asked to make and has no field to answer in.
 * Dead prompt is not free: it is tokens on every call, on a free tier measured
 * in tokens per day.
 *
 * The trims are all "does this change which index gets picked":
 *  - bias items capped to the 8 heaviest; a weight-0 factor cannot tip a choice
 *  - the narrative truncated — it is prose *about* the factors already listed
 *  - gaps reduced to a count; which source failed doesn't change level choice,
 *    it changes confidence, and that is computed elsewhere
 *  - candidate lists capped at 6, which is more structures than any of these
 *    instruments produces near price anyway
 */
function buildPrompt(input: TradePlanInput): string {
  const list = (items: Candidate[]) =>
    items
      .slice(0, MAX_CANDIDATES)
      .map((c, i) => `  [${i}] ${c.price} — ${c.label}`)
      .join("\n");

  const heaviest = [...input.bias_items]
    .filter((b) => b.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_BIAS_ITEMS);

  return (
    `你是交易計畫決策助手。以下是 ${input.symbol} 的分析結果，訊號方向為 ${input.direction === "long" ? "做多" : "做空"}。\n` +
    `是否進場已由計分規則決定為「進場」，你的工作只是從清單中挑出最合適的三個價位並說明理由。\n\n` +
    `評等：${input.grade}（方向分 ${input.bias_score}、結構分 ${input.entry_structure_score}、總分 ${input.total_score}）\n\n` +
    `分析摘要：\n${input.narrative.slice(0, MAX_NARRATIVE_CHARS)}\n\n` +
    `主要因子（依權重前 ${MAX_BIAS_ITEMS}）：\n` +
    (heaviest.length > 0
      ? heaviest
          .map((b) => `  - [${b.dimension}/${b.direction}/權重${b.weight}] ${b.factor}`)
          .join("\n")
      : "  （無）") +
    (input.knownGaps.length > 0
      ? `\n\n注意：本次有 ${input.knownGaps.length} 項資料缺口，部分面向資訊不完整。`
      : "") +
    `\n\n可選的進場點：\n${list(input.entryCandidates)}\n` +
    `\n可選的停損點：\n${list(input.slCandidates)}\n` +
    `\n可選的停利點：\n${list(input.tpCandidates)}\n\n` +
    `嚴格規則：\n` +
    `1. 你只能從上面清單中「選編號」，絕對不可以自己提出任何新的價格數字。\n` +
    `2. 只准根據以上提供的資料推論，不准補充未提供的事實。`
  );
}

interface AiResponse {
  entry_index?: number;
  sl_index?: number;
  tp_index?: number;
  entry_reason?: string;
  sl_reason?: string;
  tp_reason?: string;
  summary?: string;
}

/**
 * Shape only — the index *values* are validated against the real candidate
 * lists in buildTradePlan, since the schema has no view of how many candidates
 * were offered. That check is what stops a model from naming a price we never
 * computed, so it must not be relaxed into this schema.
 */
const PLAN_SCHEMA = jsonSchema<AiResponse>(
  "trade-plan",
  `輸出嚴格的 JSON（不要 markdown code fence、不要其他文字）：\n` +
    `{"entry_index": number, "sl_index": number, "tp_index": number, ` +
    `"entry_reason": string, "sl_reason": string, "tp_reason": string, ` +
    `"summary": string}\n` +
    `三個 reason 各用一句繁體中文說明為何選這個點，wait_for 填空字串。\n` +
    `summary 一律用繁體中文 80 字內總結你的判斷邏輯與主要風險。`,
  // Validated on the indices, not on a stance field — this schema is only
  // reached once the rules have already decided to enter, so "should we trade"
  // is not a question the model is asked and not a field it can answer.
  (v) => (typeof v.entry_index === "number" ? (v as AiResponse) : null),
);

function validIndex(value: unknown, list: Candidate[]): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < list.length;
}

/**
 * Asks the AI to decide 進場 vs 觀望, and when entering, to pick the best
 * entry/SL/TP *by index* from candidates derived entirely from real structure.
 * Any invalid or out-of-range index — i.e. any attempt to answer with a price
 * we didn't offer — falls back to the deterministic plan rather than trusting
 * the model with a raw number.
 *
 * That guarantee is provider-independent by construction: the model never sees
 * a field where a price would be accepted, so swapping Gemini for Groq or
 * anything else cannot widen what it is able to say.
 */
export async function buildTradePlan(input: TradePlanInput, gaps: string[]): Promise<TradePlan> {
  // 進場與否是計分規則的決定，不是 AI 的。
  const verdict = decideStance(input);
  if (verdict.stance === "wait") {
    // No AI call at all on this path. It has nothing left to decide, and a
    // scan that stands aside shouldn't spend quota to be told so.
    return waitPlan(verdict.summary, verdict.waitFor, "fallback");
  }

  const result = await completeAI(buildPrompt(input), PLAN_SCHEMA, gaps, { maxTokens: 900 });
  if (!result) {
    gaps.push("交易計畫改用預設規則判斷");
    return fallbackPlan(input);
  }
  const parsed = result.value;

  if (
    !validIndex(parsed.entry_index, input.entryCandidates) ||
    !validIndex(parsed.sl_index, input.slCandidates) ||
    !validIndex(parsed.tp_index, input.tpCandidates)
  ) {
    gaps.push("交易計畫 AI 回傳的價位編號無效（可能試圖給出清單外的價格），已改用預設規則");
    return fallbackPlan(input);
  }

  const entry = input.entryCandidates[parsed.entry_index];
  const sl = input.slCandidates[parsed.sl_index];
  const tp = input.tpCandidates[parsed.tp_index];
  const rr = riskReward(input.direction, entry.price, sl.price, tp.price);
  if (rr === null) {
    gaps.push("AI 選出的停損／停利方向不合理（停損未在虧損側或停利未在獲利側），已改用預設規則");
    return fallbackPlan(input);
  }
  // The same floor the deterministic path applies. It was missing here, so the
  // AI could hand back a trade risking more than it stood to make while the
  // fallback would have refused the identical geometry.
  if (rr < MIN_RISK_REWARD) {
    gaps.push(`AI 選出的組合風險報酬比僅 1:${rr}，低於 1:${MIN_RISK_REWARD} 門檻，已改用預設規則`);
    return fallbackPlan(input);
  }

  // Not taken from the model. `lib/analysis/confidence.ts` computes the number
  // the card actually shows, from the grade, the geometry, the gap count and
  // the local backtest; letting the plan carry a *different*, model-authored
  // word beside it would be two answers to one question.
  //
  // Approximated here from what this function can see — the full computation
  // needs the assembled signal, which does not exist yet at this point.
  const confidence: "high" | "medium" | "low" =
    input.grade === "A+" || input.grade === "A" ? "high" : input.grade === "B" ? "medium" : "low";

  return {
    stance: "enter",
    entry: round(entry.price),
    stop_loss: round(sl.price),
    take_profit: round(tp.price),
    entry_reason: parsed.entry_reason?.trim() || entry.label,
    stop_loss_reason: parsed.sl_reason?.trim() || sl.label,
    take_profit_reason: parsed.tp_reason?.trim() || tp.label,
    risk_reward: rr,
    confidence,
    summary: parsed.summary?.trim() || "（AI 未提供總結）",
    add_ons: [],
    wait_for: null,
    decided_by: "ai",
  };
}

/** Builds the candidate lists from an already-computed signal's real structures. */
export function collectCandidates(
  signal: Pick<
    TradeSignal,
    "direction" | "entry_zone" | "stop_loss" | "take_profits" | "entry_structures"
  >,
  atr: number | null,
): { entryCandidates: Candidate[]; slCandidates: Candidate[]; tpCandidates: Candidate[] } {
  const mid = (signal.entry_zone.low + signal.entry_zone.high) / 2;
  const entryCandidates: Candidate[] = [
    { price: round(mid), label: `現價進場（${signal.entry_zone.reason}）` },
  ];
  // Pullback entries: protecting structures the price could retrace into.
  for (const s of signal.entry_structures) {
    const isPullback =
      signal.direction === "long" ? s.role === "support" && s.price < mid : s.role === "resistance" && s.price > mid;
    if (isPullback && Math.abs(s.distance_pct) <= 1.5) {
      entryCandidates.push({
        price: round(s.price),
        label: `等回測 ${s.timeframe} ${s.type}（強度 ${s.strength}，距現價 ${s.distance_pct}%）`,
      });
    }
  }

  const slCandidates: Candidate[] = [
    {
      price: signal.stop_loss.price,
      label: `${signal.stop_loss.structure}｜${signal.stop_loss.reason}`,
    },
  ];
  // A wider alternative: one ATR beyond the same structure, for noisier conditions.
  if (atr && atr > 0) {
    const wider =
      signal.direction === "long" ? signal.stop_loss.price - atr * 0.5 : signal.stop_loss.price + atr * 0.5;
    slCandidates.push({
      price: round(wider),
      label: `同結構外再放寬 0.5×ATR（較不易被雜訊掃到，風險較大）`,
    });
  }

  const tpCandidates: Candidate[] = signal.take_profits.map((tp) => ({
    price: tp.price,
    label: `${tp.structure}｜${tp.reason}`,
  }));

  return { entryCandidates, slCandidates, tpCandidates };
}

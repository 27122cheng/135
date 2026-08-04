import { completeAI, jsonSchema } from "@/lib/ai";
import type { BiasItem, Grade, TradePlan, TradeSignal } from "@/types/signal";

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
  const entry = input.entryCandidates[0];
  const sl = input.slCandidates[0];
  const tp = input.tpCandidates[0];
  if (!entry || !sl || !tp) {
    return waitPlan(
      "缺少可用的進場、停損或停利結構，無法組成計畫。",
      "等待價格接近有效的支撐／壓力結構。",
      "fallback",
    );
  }
  const rr = riskReward(input.direction, entry.price, sl.price, tp.price);
  if (rr === null) {
    return waitPlan(
      "預設規則算出的停損／停利方向不合理，無法組成計畫。",
      "等待更清楚的結構出現。",
      "fallback",
    );
  }
  // A trade that risks more than it stands to make isn't worth taking.
  if (rr < 1) {
    return waitPlan(
      `預設規則算出的風險報酬比僅 1:${rr}，賠率不划算，建議觀望。`,
      `等待價格回落到更好的進場位置（例如 ${round(input.entryCandidates.at(-1)?.price ?? entry.price)} 附近），或等更遠的停利結構出現。`,
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
      "取最接近的進場點、最近的保護結構做停損、路徑上第一個障礙做停利。",
    wait_for: null,
    decided_by: "fallback",
  };
}

function buildPrompt(input: TradePlanInput): string {
  const list = (items: Candidate[]) =>
    items.map((c, i) => `  [${i}] ${c.price} — ${c.label}`).join("\n");
  return (
    `你是交易計畫決策助手。以下是 ${input.symbol} 的分析結果，訊號方向為 ${input.direction === "long" ? "做多" : "做空"}。\n\n` +
    `評等：${input.grade}（方向分 ${input.bias_score}、結構分 ${input.entry_structure_score}、總分 ${input.total_score}）\n\n` +
    `分析摘要：\n${input.narrative}\n\n` +
    `六面向因子：\n` +
    (input.bias_items.length > 0
      ? input.bias_items
          .map((b) => `  - [${b.dimension}/${b.direction}/權重${b.weight}] ${b.factor}｜${b.evidence}`)
          .join("\n")
      : "  （無）") +
    (input.knownGaps.length > 0
      ? `\n\n已知資料缺口（這些面向目前是瞎的，判斷時要把不確定性算進去）：\n` +
        input.knownGaps.map((g) => `  - ${g}`).join("\n")
      : "") +
    `\n\n可選的進場點：\n${list(input.entryCandidates)}\n` +
    `\n可選的停損點：\n${list(input.slCandidates)}\n` +
    `\n可選的停利點：\n${list(input.tpCandidates)}\n\n` +
    `請綜合以上所有資料，決定現在應該「進場」還是「觀望」。\n\n` +
    (input.gradeForcesWait
      ? `注意：本訊號依硬性計分規則已判定為 no-trade，因此 stance 必須是 "wait"。` +
        `請說明為什麼不值得進場，以及要等到什麼條件出現才值得重新評估。\n\n`
      : `觀望是完全正當的結論，不要為了給答案而硬湊一筆交易。` +
        `遇到以下情況請直接選擇觀望：六面向彼此矛盾、風險報酬比不划算、` +
        `關鍵面向因資料缺口而無法判斷、或進場點離結構太遠。\n\n`) +
    `嚴格規則：\n` +
    `1. 你只能從上面清單中「選編號」，絕對不可以自己提出任何新的價格數字。\n` +
    `2. 只准根據以上提供的資料推論，不准補充未提供的事實。`
  );
}

interface AiResponse {
  stance?: string;
  entry_index?: number;
  sl_index?: number;
  tp_index?: number;
  entry_reason?: string;
  sl_reason?: string;
  tp_reason?: string;
  confidence?: string;
  summary?: string;
  wait_for?: string;
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
    `{"stance": "enter"|"wait", "entry_index": number, "sl_index": number, "tp_index": number, ` +
    `"entry_reason": string, "sl_reason": string, "tp_reason": string, ` +
    `"confidence": "high"|"medium"|"low", "summary": string, "wait_for": string}\n` +
    `stance="wait" 時，三個 index 可填 0（會被忽略），但 wait_for 必填：用一句繁體中文說明「要等什麼條件出現才考慮進場」。\n` +
    `stance="enter" 時，三個 reason 各用一句繁體中文說明為何選這個點，wait_for 填空字串。\n` +
    `summary 一律用繁體中文 80 字內總結你的判斷邏輯與主要風險。`,
  (v) => (typeof v.stance === "string" ? (v as AiResponse) : null),
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
  const noCandidates =
    input.entryCandidates.length === 0 ||
    input.slCandidates.length === 0 ||
    input.tpCandidates.length === 0;

  if (noCandidates && !input.gradeForcesWait) {
    return waitPlan(
      "沒有足夠的真實結構可以組成進場／停損／停利，依規則觀望。",
      "等待價格接近有效的支撐／壓力結構。",
      "fallback",
    );
  }

  const result = await completeAI(buildPrompt(input), PLAN_SCHEMA, gaps, { maxTokens: 900 });
  if (!result) {
    gaps.push("交易計畫改用預設規則判斷");
    return fallbackPlan(input);
  }
  const parsed = result.value;

  const wantsWait = parsed.stance !== "enter";
  // The hard scoring rules win: a no-trade grade can never become an entry.
  if (wantsWait || input.gradeForcesWait || noCandidates) {
    if (!wantsWait && input.gradeForcesWait) {
      gaps.push("AI 建議進場但評等為 no-trade，依硬性規則強制改為觀望");
    }
    return waitPlan(
      parsed.summary?.trim() || "AI 判斷目前不值得進場。",
      parsed.wait_for?.trim() || "等待更明確的訊號出現。",
      "ai",
    );
  }

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

  const confidence =
    parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low"
      ? parsed.confidence
      : "medium";

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

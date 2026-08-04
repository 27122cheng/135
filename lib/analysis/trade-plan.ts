import Anthropic from "@anthropic-ai/sdk";
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

function notActionable(reason: string, decidedBy: "ai" | "fallback" = "fallback"): TradePlan {
  return {
    actionable: false,
    entry: null,
    stop_loss: null,
    take_profit: null,
    entry_reason: "—",
    stop_loss_reason: "—",
    take_profit_reason: "—",
    risk_reward: null,
    confidence: "low",
    summary: reason,
    decided_by: decidedBy,
  };
}

/** Deterministic choice used when the AI is unavailable or returns anything invalid. */
function fallbackPlan(input: TradePlanInput): TradePlan {
  const entry = input.entryCandidates[0];
  const sl = input.slCandidates[0];
  const tp = input.tpCandidates[0];
  if (!entry || !sl || !tp) {
    return notActionable("缺少可用的進場、停損或停利結構，不建議進場。");
  }
  const rr = riskReward(input.direction, entry.price, sl.price, tp.price);
  return {
    actionable: true,
    entry: round(entry.price),
    stop_loss: round(sl.price),
    take_profit: round(tp.price),
    entry_reason: entry.label,
    stop_loss_reason: sl.label,
    take_profit_reason: tp.label,
    risk_reward: rr,
    confidence: input.grade === "A+" || input.grade === "A" ? "medium" : "low",
    summary:
      `未使用 AI 判斷（未設定 ANTHROPIC_API_KEY 或呼叫失敗），改用預設規則：` +
      `取最接近的進場點、最近的保護結構做停損、路徑上第一個障礙做停利。`,
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
    input.bias_items
      .map((b) => `  - [${b.dimension}/${b.direction}/權重${b.weight}] ${b.factor}｜${b.evidence}`)
      .join("\n") +
    `\n\n可選的進場點：\n${list(input.entryCandidates)}\n` +
    `\n可選的停損點：\n${list(input.slCandidates)}\n` +
    `\n可選的停利點：\n${list(input.tpCandidates)}\n\n` +
    `請綜合以上所有資料，選出你認為最好的一組進場／停損／停利組合。\n\n` +
    `嚴格規則：\n` +
    `1. 你只能從上面清單中「選編號」，絕對不可以自己提出任何新的價格數字。\n` +
    `2. 只准根據以上提供的資料推論，不准補充未提供的事實。\n` +
    `3. 若你認為這筆交易不值得進場（例如訊號矛盾、風險報酬比太差），把 actionable 設為 false。\n\n` +
    `輸出嚴格的 JSON（不要 markdown code fence、不要其他文字）：\n` +
    `{"actionable": boolean, "entry_index": number, "sl_index": number, "tp_index": number, ` +
    `"entry_reason": string, "sl_reason": string, "tp_reason": string, ` +
    `"confidence": "high"|"medium"|"low", "summary": string}\n` +
    `三個 reason 各用一句繁體中文說明為何選這個點；summary 用繁體中文 80 字內總結這個計畫的邏輯與主要風險。`
  );
}

interface AiResponse {
  actionable?: boolean;
  entry_index?: number;
  sl_index?: number;
  tp_index?: number;
  entry_reason?: string;
  sl_reason?: string;
  tp_reason?: string;
  confidence?: string;
  summary?: string;
}

function parse(text: string): AiResponse | null {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]) as AiResponse;
  } catch {
    return null;
  }
}

function validIndex(value: unknown, list: Candidate[]): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < list.length;
}

/**
 * Asks Claude to pick the single best entry/SL/TP *by index* from candidates
 * derived entirely from real structure. Any invalid or out-of-range index —
 * i.e. any attempt to answer with something we didn't offer — falls back to
 * the deterministic plan rather than trusting the model with a raw price.
 */
export async function buildTradePlan(input: TradePlanInput, gaps: string[]): Promise<TradePlan> {
  if (input.entryCandidates.length === 0 || input.slCandidates.length === 0 || input.tpCandidates.length === 0) {
    return notActionable(
      "沒有足夠的真實結構可以組成進場／停損／停利（缺少保護結構或路徑障礙），依規則不建議進場。",
    );
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    gaps.push("缺少 ANTHROPIC_API_KEY，AI 交易計畫改用預設規則挑選價位");
    return fallbackPlan(input);
  }

  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5",
      max_tokens: 900,
      messages: [{ role: "user", content: buildPrompt(input) }],
    });
    const block = message.content.find((b) => b.type === "text");
    const parsed = parse(block && block.type === "text" ? block.text : "");
    if (!parsed) {
      gaps.push("AI 交易計畫回應格式無法解析，改用預設規則");
      return fallbackPlan(input);
    }

    if (parsed.actionable === false) {
      return notActionable(
        parsed.summary?.trim() || "AI 判斷此筆訊號不值得進場。",
        "ai",
      );
    }

    if (
      !validIndex(parsed.entry_index, input.entryCandidates) ||
      !validIndex(parsed.sl_index, input.slCandidates) ||
      !validIndex(parsed.tp_index, input.tpCandidates)
    ) {
      gaps.push("AI 交易計畫回傳的價位編號無效（可能試圖給出清單外的價格），已改用預設規則");
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
      actionable: true,
      entry: round(entry.price),
      stop_loss: round(sl.price),
      take_profit: round(tp.price),
      entry_reason: parsed.entry_reason?.trim() || entry.label,
      stop_loss_reason: parsed.sl_reason?.trim() || sl.label,
      take_profit_reason: parsed.tp_reason?.trim() || tp.label,
      risk_reward: rr,
      confidence,
      summary: parsed.summary?.trim() || "（AI 未提供總結）",
      decided_by: "ai",
    };
  } catch {
    gaps.push("呼叫 Anthropic API 產生 AI 交易計畫失敗，改用預設規則");
    return fallbackPlan(input);
  }
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

import Anthropic from "@anthropic-ai/sdk";
import type { BiasItem, EntryStructure, PathObstacle } from "@/types/signal";

export interface NarrativeInput {
  symbol: string;
  direction: "long" | "short";
  bias_score: number;
  entry_structure_score: number;
  total_score: number;
  grade: string;
  bias_items: BiasItem[];
  entry_structures: EntryStructure[];
  path_obstacles: PathObstacle[];
  news_summary: string | null;
}

function fallbackNarrative(input: NarrativeInput): string {
  const against = input.bias_items.filter(
    (b) => b.direction !== "neutral" && b.direction !== input.direction,
  );
  return (
    `[本地備援敘述，非 AI 生成] ${input.symbol} 綜合評等 ${input.grade}` +
    `（bias_score=${input.bias_score}, entry_structure_score=${input.entry_structure_score}, total=${input.total_score}）。` +
    (against.length > 0
      ? `注意：有 ${against.length} 項因子與訊號方向相反，需留意衝突風險：${against.map((a) => a.factor).join("；")}`
      : "六面向未見明顯反向衝突。")
  );
}

/**
 * AI綜合：把五個結構化面向的 JSON 交給 Claude 產生 narrative 與衝突提醒。
 * Prompt 明確要求只能根據傳入資料推論，不准補充未提供的事實。
 */
export async function generateNarrative(input: NarrativeInput, gaps: string[]): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    gaps.push("缺少 ANTHROPIC_API_KEY，AI 綜合敘述改用本地備援文字");
    return fallbackNarrative(input);
  }
  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL ?? "claude-opus-5",
      max_tokens: 700,
      messages: [
        {
          role: "user",
          content:
            `你是交易訊號的綜合分析助手。以下是結構化 JSON 資料，請只根據這些資料進行推論並指出潛在衝突` +
            `（例如某個面向的方向與整體訊號方向相反）。不准補充未提供的事實或數字，不准臆測未包含在資料中的消息。` +
            `用繁體中文輸出一段 150-250 字的敘述性段落，不要用 JSON，不要條列。\n\n${JSON.stringify(input, null, 2)}`,
        },
      ],
    });
    const block = message.content.find((b) => b.type === "text");
    const text = block && block.type === "text" ? block.text.trim() : "";
    if (!text) {
      gaps.push("AI 綜合敘述回應為空，改用本地備援文字");
      return fallbackNarrative(input);
    }
    return text;
  } catch {
    gaps.push("呼叫 Anthropic API 產生 AI 綜合敘述失敗，改用本地備援文字");
    return fallbackNarrative(input);
  }
}

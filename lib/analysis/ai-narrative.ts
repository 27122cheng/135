import { completeAI, textSchema } from "@/lib/ai";
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
  /** The news takeaways, so the narrative can reason about them by name. */
  news_key_points?: Array<{ point: string; impact: string }>;
}

/**
 * The deterministic summary.
 *
 * Two callers with two different meanings, hence the label: the AI chain
 * failed, or the AI was never asked because the grade could not trade. A reader
 * seeing "本地備援" needs to know which — the first is a degraded run worth
 * investigating, the second is the system deliberately not spending tokens.
 */
export function ruleNarrative(input: NarrativeInput, label: string): string {
  const against = input.bias_items.filter(
    (b) => b.direction !== "neutral" && b.direction !== input.direction,
  );
  return (
    `[${label}] ${input.symbol} 綜合評等 ${input.grade}` +
    `（bias_score=${input.bias_score}, entry_structure_score=${input.entry_structure_score}, total=${input.total_score}）。` +
    (against.length > 0
      ? `注意：有 ${against.length} 項因子與訊號方向相反，需留意衝突風險：${against.map((a) => a.factor).join("；")}`
      : "六面向未見明顯反向衝突。")
  );
}

function fallbackNarrative(input: NarrativeInput): string {
  return ruleNarrative(input, "本地備援敘述，非 AI 生成");
}

const SCHEMA = textSchema(
  "用繁體中文輸出一段 150-250 字的敘述性段落，不要用 JSON，不要條列，不要 markdown。",
);

/**
 * AI綜合：把五個結構化面向的 JSON 交給 AI 產生 narrative 與衝突提醒。
 * Prompt 明確要求只能根據傳入資料推論，不准補充未提供的事實。
 *
 * Goes through the provider chain (lib/ai), so it works on whichever free tier
 * is configured and degrades to deterministic local prose when none is.
 */
export async function generateNarrative(
  input: NarrativeInput,
  gaps: string[],
  /** `symbol:h4BarTime` — see CompleteOptions.cacheKey for why. */
  cacheKey?: string,
  /** What is left of the scan's own clock; see CompleteOptions.budgetMs. */
  budgetMs?: number,
): Promise<string> {
  const prompt =
    `你是交易訊號的綜合分析助手。以下是結構化 JSON 資料，請只根據這些資料進行推論並指出潛在衝突` +
    `（例如某個面向的方向與整體訊號方向相反）。不准補充未提供的事實或數字，不准臆測未包含在資料中的消息。\n\n` +
    JSON.stringify(input, null, 2);

  const result = await completeAI(prompt, SCHEMA, gaps, { maxTokens: 700, cacheKey, budgetMs });
  if (!result) {
    gaps.push("AI 綜合敘述改用本地備援文字");
    return fallbackNarrative(input);
  }
  return result.value;
}

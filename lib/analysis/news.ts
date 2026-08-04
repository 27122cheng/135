import Anthropic from "@anthropic-ai/sdk";
import type { BiasItem } from "@/types/signal";
import { fetchGdeltNews } from "../data-sources/gdelt";
import { fetchFinnhubMarketNews } from "../data-sources/finnhub";

interface Article {
  headline: string;
  source: string;
  url: string;
  datetime: string;
}

export interface NewsAnalysisResult {
  biasItems: BiasItem[];
  summary: string | null;
  sources: string[];
}

function buildPrompt(articles: Article[]): string {
  const list = articles
    .slice(0, 20)
    .map((a, i) => `${i + 1}. [${a.datetime}] (${a.source}) ${a.headline}`)
    .join("\n");
  return (
    `你是外匯/大宗商品新聞分析助手。以下是過去48小時內的新聞標題列表：\n\n${list}\n\n` +
    `請只根據以上標題進行推論，不准補充未提供的事實。輸出嚴格的 JSON（不要有其他文字、不要 markdown code fence），格式為：\n` +
    `{"score": number, "summary": string}\n` +
    `score 是 -1 到 +1 的情緒分數（正值偏多、負值偏空），summary 是不超過100字的繁體中文摘要。`
  );
}

function parseResponse(text: string): { score: number; summary: string } | null {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (typeof parsed.score !== "number" || typeof parsed.summary !== "string") return null;
    return { score: Math.max(-1, Math.min(1, parsed.score)), summary: parsed.summary };
  } catch {
    return null;
  }
}

/** 新聞面：抓近 48h 新聞（GDELT + Finnhub），交給 Claude 評 -1~+1 情緒分並摘要，附來源連結。*/
export async function analyzeNews(
  gdeltQuery: string,
  finnhubKeywords: string[],
  gaps: string[],
): Promise<NewsAnalysisResult> {
  const [gdelt, finnhub] = await Promise.all([
    fetchGdeltNews(gdeltQuery, gaps),
    fetchFinnhubMarketNews("general", finnhubKeywords, gaps),
  ]);
  const articles: Article[] = [
    ...(gdelt ?? []).map((a) => ({ headline: a.headline, source: a.source, url: a.url, datetime: a.datetime })),
    ...(finnhub ?? []).map((a) => ({ headline: a.headline, source: a.source, url: a.url, datetime: a.datetime })),
  ];
  if (articles.length === 0) {
    gaps.push("近 48 小時無相關新聞（GDELT 與 Finnhub 皆無結果或取得失敗）");
    return { biasItems: [], summary: null, sources: [] };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    gaps.push("缺少 ANTHROPIC_API_KEY，無法對新聞進行情緒評分");
    return { biasItems: [], summary: null, sources: articles.map((a) => a.url) };
  }

  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5",
      max_tokens: 500,
      messages: [{ role: "user", content: buildPrompt(articles) }],
    });
    const block = message.content.find((b) => b.type === "text");
    const text = block && block.type === "text" ? block.text : "";
    const parsed = parseResponse(text);
    if (!parsed) {
      gaps.push("新聞情緒評分：AI 回應格式無法解析");
      return { biasItems: [], summary: null, sources: articles.map((a) => a.url) };
    }
    const direction = parsed.score > 0.15 ? "long" : parsed.score < -0.15 ? "short" : "neutral";
    const weight = Math.abs(parsed.score) >= 0.5 ? 2 : Math.abs(parsed.score) >= 0.15 ? 1 : 0;
    const biasItems: BiasItem[] = [
      {
        dimension: "新聞面",
        factor: `近48小時新聞情緒分 ${parsed.score.toFixed(2)} (-1~+1)，共 ${articles.length} 篇`,
        direction,
        weight,
        evidence: `情緒分 ${parsed.score.toFixed(2)}，樣本數 ${articles.length}`,
        source: "GDELT 2.0 doc API + Finnhub /news + Claude 情緒評分",
      },
    ];
    return { biasItems, summary: parsed.summary, sources: articles.slice(0, 10).map((a) => a.url) };
  } catch {
    gaps.push("呼叫 Anthropic API 進行新聞情緒評分失敗");
    return { biasItems: [], summary: null, sources: articles.map((a) => a.url) };
  }
}

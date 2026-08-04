import { completeAI, jsonSchema } from "@/lib/ai";
import type { BiasItem } from "@/types/signal";
import { fetchGdeltNews } from "../data-sources/gdelt";
import { fetchFinnhubMarketNews } from "../data-sources/finnhub";
import { scoreHeadlines } from "./news-lexicon";

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
    `請只根據以上標題進行推論，不准補充未提供的事實。`
  );
}

interface Sentiment {
  score: number;
  summary: string;
}

/**
 * Batch sentiment over all headlines in one call — one request per symbol
 * rather than one per headline, which is what keeps this inside a 30 req/min
 * free tier.
 */
const SENTIMENT_SCHEMA = jsonSchema<Sentiment>(
  "sentiment",
  `輸出嚴格的 JSON（不要有其他文字、不要 markdown code fence），格式為：\n` +
    `{"score": number, "summary": string}\n` +
    `score 是 -1 到 +1 的情緒分數（正值偏多、負值偏空），summary 是不超過100字的繁體中文摘要。`,
  (v) => {
    if (typeof v.score !== "number" || !Number.isFinite(v.score)) return null;
    if (typeof v.summary !== "string" || v.summary.trim() === "") return null;
    return { score: Math.max(-1, Math.min(1, v.score)), summary: v.summary.trim() };
  },
);

/**
 * Zero-key path: keyword sentiment over the same headlines. Weight is capped
 * at 1 (the AI path can reach 2) because keyword counting can't read context.
 */
function lexiconResult(articles: Article[], gaps: string[]): NewsAnalysisResult {
  const { score, bullishHits, bearishHits, matched } = scoreHeadlines(
    articles.map((a) => a.headline),
  );
  const sources = articles.slice(0, 10).map((a) => a.url);

  if (matched === 0) {
    gaps.push(
      `新聞面改用本地關鍵字評分，但 ${articles.length} 則標題中無可辨識的多空關鍵字`,
    );
    return { biasItems: [], summary: null, sources };
  }

  gaps.push("新聞面改用本地關鍵字評分（準確度低於 AI 評分，權重上限 1）");

  const direction = score > 0.2 ? "long" : score < -0.2 ? "short" : "neutral";
  const biasItems: BiasItem[] =
    direction === "neutral"
      ? []
      : [
          {
            dimension: "新聞面",
            factor: `近48小時新聞關鍵字情緒分 ${score.toFixed(2)}（多空關鍵字 ${bullishHits}:${bearishHits}）`,
            direction,
            weight: 1,
            evidence: `${articles.length} 則標題中 ${matched} 則含多空關鍵字，多方 ${bullishHits} 次／空方 ${bearishHits} 次`,
            source: "GDELT 2.0 doc API + 本地關鍵字表（非 AI 評分）",
          },
        ];

  return {
    biasItems,
    summary: `［關鍵字評分，非 AI］近 48 小時 ${articles.length} 則新聞中 ${matched} 則含多空關鍵字，整體${direction === "long" ? "偏多" : direction === "short" ? "偏空" : "中性"}（${score.toFixed(2)}）。`,
    sources,
  };
}

/** 新聞面：抓近 48h 新聞（GDELT + Finnhub），交給 AI 評 -1~+1 情緒分並摘要，附來源連結。*/
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

  const result = await completeAI(buildPrompt(articles), SENTIMENT_SCHEMA, gaps, {
    maxTokens: 500,
  });
  if (!result) {
    // Every provider unconfigured, over quota, or failing — fall back to keyword
    // scoring rather than dropping the whole 新聞面 dimension. Lower confidence,
    // and labelled as such wherever it appears.
    return lexiconResult(articles, gaps);
  }

  const { score, summary } = result.value;
  const direction = score > 0.15 ? "long" : score < -0.15 ? "short" : "neutral";
  const weight = Math.abs(score) >= 0.5 ? 2 : Math.abs(score) >= 0.15 ? 1 : 0;
  const biasItems: BiasItem[] = [
    {
      dimension: "新聞面",
      factor: `近48小時新聞情緒分 ${score.toFixed(2)} (-1~+1)，共 ${articles.length} 篇`,
      direction,
      weight,
      evidence: `情緒分 ${score.toFixed(2)}，樣本數 ${articles.length}`,
      source: `GDELT 2.0 doc API + Finnhub /news + ${result.provider} 情緒評分`,
    },
  ];
  return { biasItems, summary, sources: articles.slice(0, 10).map((a) => a.url) };
}

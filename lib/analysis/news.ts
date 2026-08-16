import { completeAI, jsonSchema } from "@/lib/ai";
import type { BiasItem, NewsDigest, NewsKeyPoint, NewsSource } from "@/types/signal";
import { fetchGdeltNews } from "../data-sources/gdelt";
import { fetchGoogleNews } from "../data-sources/google-news";
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
  /** The full read-out shown on the card; null when there were no headlines. */
  digest: NewsDigest | null;
}

/** How many headlines the model is shown. Also the size of the citable list. */
const PROMPT_LIMIT = 20;

function buildPrompt(articles: Article[]): string {
  const list = articles
    .map((a, i) => `[${i}] (${a.source}, ${a.datetime.slice(0, 16)}) ${a.headline}`)
    .join("\n");
  return (
    `你是外匯/大宗商品新聞分析助手。以下是過去 48 小時內的新聞標題，每則前面是它的編號：\n\n` +
    `${list}\n\n` +
    `請做兩件事：\n` +
    `1. 歸納出 2-4 個對這個商品最重要的新聞重點，每個重點標明它偏多、偏空還是中性，` +
    `並用編號指出它是根據哪幾則標題。\n` +
    `2. 給一個整體情緒分數與摘要。\n\n` +
    `嚴格規則：只准根據以上標題推論，不准補充標題裡沒有的事實或數字。` +
    `引用時只能用上面出現過的編號，不可以自己編。` +
    `如果標題與這個商品關聯很弱，就誠實說關聯不大、分數給接近 0，不要硬湊。`
  );
}

interface RawKeyPoint {
  point?: unknown;
  impact?: unknown;
  sources?: unknown;
}

interface Analysis {
  score: number;
  summary: string;
  keyPoints: NewsKeyPoint[];
}

/**
 * Builds the schema against a known headline count so citation indices can be
 * range-checked at parse time. A point citing a headline we never supplied is
 * dropped rather than shown — the same rule the trade plan applies to prices.
 */
function analysisSchema(headlineCount: number) {
  return jsonSchema<Analysis>(
    "news-analysis",
    `輸出嚴格的 JSON（不要有其他文字、不要 markdown code fence），格式為：\n` +
      `{"score": number, "summary": string, "key_points": [{"point": string, ` +
      `"impact": "long"|"short"|"neutral", "sources": number[]}]}\n` +
      `score 是 -1 到 +1 的情緒分數（正值偏多、負值偏空）。\n` +
      `summary 是不超過 100 字的繁體中文整體摘要。\n` +
      `key_points 2-4 個，每個 point 用一句繁體中文（40 字內），` +
      `sources 填該重點依據的標題編號（0 到 ${headlineCount - 1}）。`,
    (v) => {
      if (typeof v.score !== "number" || !Number.isFinite(v.score)) return null;
      if (typeof v.summary !== "string" || v.summary.trim() === "") return null;

      const rawPoints = Array.isArray(v.key_points) ? (v.key_points as RawKeyPoint[]) : [];
      const keyPoints: NewsKeyPoint[] = [];
      for (const raw of rawPoints) {
        if (typeof raw.point !== "string" || raw.point.trim() === "") continue;
        const impact =
          raw.impact === "long" || raw.impact === "short" || raw.impact === "neutral"
            ? raw.impact
            : "neutral";
        // Keep only citations that point at a headline that exists.
        const sources = Array.isArray(raw.sources)
          ? raw.sources.filter(
              (n): n is number =>
                typeof n === "number" && Number.isInteger(n) && n >= 0 && n < headlineCount,
            )
          : [];
        keyPoints.push({ point: raw.point.trim(), impact, sources });
      }

      return {
        score: Math.max(-1, Math.min(1, v.score)),
        summary: v.summary.trim(),
        keyPoints: keyPoints.slice(0, 4),
      };
    },
  );
}

function toSources(articles: Article[]): NewsSource[] {
  return articles.map((a) => ({
    headline: a.headline,
    domain: a.source,
    url: a.url,
    datetime: a.datetime,
  }));
}

/**
 * Zero-key path: keyword sentiment over the same headlines. Weight is capped
 * at 1 (the AI path can reach 2) because keyword counting can't read context.
 */
function lexiconResult(articles: Article[], gaps: string[]): NewsAnalysisResult {
  const { score, bullishHits, bearishHits, matched, neutralMatched } = scoreHeadlines(
    articles.map((a) => a.headline),
  );
  const sources = articles.slice(0, 10).map((a) => a.url);
  const digestSources = toSources(articles.slice(0, PROMPT_LIMIT));

  if (matched === 0) {
    // A quiet news day and an unreadable one are different answers, and they
    // used to produce the identical data gap. When the headlines *did* say
    // something — steady, flat, awaiting the Fed — that is a finding about the
    // market, not a failure of the reader, and it belongs in the factors at
    // weight 0 rather than in the warning list.
    const quiet = neutralMatched > 0;
    if (quiet) {
      return {
        biasItems: [
          {
            dimension: "新聞面",
            key: "news-sentiment",
            factor: `近 48 小時 ${articles.length} 則標題語氣持平（${neutralMatched} 則明確為觀望／持平用語），新聞面無方向`,
            direction: "neutral",
            weight: 0,
            evidence: `多空關鍵字 0 次，中性用語 ${neutralMatched} 次`,
            source: `GDELT ${articles.length} 則標題（本地關鍵字表）`,
          },
        ],
        summary: null,
        sources,
        digest: {
          score: 0,
          summary: `近 48 小時 ${articles.length} 則標題以持平／觀望用語為主，沒有明顯的多空方向。`,
          key_points: [],
          headline_count: articles.length,
          sources: digestSources,
          analyzed_by: "本地關鍵字表（非 AI）",
        },
      };
    }
    gaps.push(
      `新聞面改用本地關鍵字評分，但 ${articles.length} 則標題中既無多空關鍵字也無中性用語，關鍵字表可能不涵蓋這批標題的用語`,
    );
    // Still return the digest: the headlines are worth reading even when the
    // keyword table found nothing to score.
    return {
      biasItems: [],
      summary: null,
      sources,
      digest: {
        score: 0,
        summary: `近 48 小時 ${articles.length} 則標題中沒有可辨識的多空關鍵字，本地評分無法判斷方向。`,
        key_points: [],
        headline_count: articles.length,
        sources: digestSources,
        analyzed_by: "本地關鍵字表（非 AI）",
      },
    };
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

  const summary = `［關鍵字評分，非 AI］近 48 小時 ${articles.length} 則新聞中 ${matched} 則含多空關鍵字，整體${direction === "long" ? "偏多" : direction === "short" ? "偏空" : "中性"}（${score.toFixed(2)}）。`;
  return {
    biasItems,
    summary,
    sources,
    digest: {
      score,
      summary,
      // Keyword counting can't produce a takeaway, only a tally — so no key
      // points rather than a sentence dressed up to look like analysis.
      key_points: [],
      headline_count: articles.length,
      sources: digestSources,
      analyzed_by: "本地關鍵字表（非 AI）",
    },
  };
}

/** 新聞面：抓近 48h 新聞（GDELT，失敗時退到 Google News RSS，加上 Finnhub），
 *  交給 AI 評 -1~+1 情緒分並摘要，附來源連結。*/
export async function analyzeNews(
  gdeltQuery: string,
  finnhubKeywords: string[],
  gaps: string[],
  /** `symbol:h4BarTime` — see CompleteOptions.cacheKey. */
  aiCacheKey?: string,
): Promise<NewsAnalysisResult> {
  const [gdelt, finnhub] = await Promise.all([
    fetchGdeltNews(gdeltQuery, gaps),
    fetchFinnhubMarketNews("general", finnhubKeywords, gaps),
  ]);
  const articles: Article[] = [
    ...(gdelt ?? []).map((a) => ({ headline: a.headline, source: a.source, url: a.url, datetime: a.datetime })),
    ...(finnhub ?? []).map((a) => ({ headline: a.headline, source: a.source, url: a.url, datetime: a.datetime })),
  ];

  // GDELT down (the live failure: "連線失敗 fetch failed") used to black out
  // the whole 新聞面 dimension, because it was the only keyless headline
  // source. Google News RSS is a different company on different
  // infrastructure — asked only when the primary path came back empty, so a
  // working GDELT costs nothing extra.
  if (articles.length === 0) {
    const term = gdeltQuery.split(/\s+OR\s+/i)[0].replace(/"/g, "").trim();
    const backup = await fetchGoogleNews(term, gaps);
    for (const a of backup ?? []) {
      articles.push({ headline: a.headline, source: a.source, url: a.url, datetime: a.datetime });
    }
  }

  if (articles.length === 0) {
    // No gap pushed here on purpose. fetchGdeltNews has already said either
    // "取得失敗" or "查無相關新聞", and Finnhub is optional — adding a generic
    // "no news" line on top would report the same fact twice.
    return { biasItems: [], summary: null, sources: [], digest: null };
  }

  // Only the headlines the model is shown are citable, so the same slice backs
  // both the prompt and the digest's source list — the indices must line up.
  const shown = articles.slice(0, PROMPT_LIMIT);
  const result = await completeAI(buildPrompt(shown), analysisSchema(shown.length), gaps, {
    cacheKey: aiCacheKey,
    maxTokens: 900,
  });
  if (!result) {
    // Every provider unconfigured, over quota, or failing — fall back to keyword
    // scoring rather than dropping the whole 新聞面 dimension. Lower confidence,
    // and labelled as such wherever it appears.
    return lexiconResult(articles, gaps);
  }

  const { score, summary, keyPoints } = result.value;
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
  return {
    biasItems,
    summary,
    sources: articles.slice(0, 10).map((a) => a.url),
    digest: {
      score,
      summary,
      key_points: keyPoints,
      headline_count: articles.length,
      sources: toSources(shown),
      analyzed_by: result.provider,
    },
  };
}

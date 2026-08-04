import { cachedOrFetch } from "./cache";
import { fetchJson } from "./http";

export interface GdeltArticle {
  headline: string;
  source: string;
  url: string;
  datetime: string; // ISO
  summary: string;
}

interface GdeltDocResponse {
  articles?: Array<{
    title: string;
    domain: string;
    url: string;
    seendate: string; // e.g. 20260804T113000Z
  }>;
}

function parseGdeltDate(raw: string): string {
  // GDELT format: YYYYMMDDTHHMMSSZ
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return new Date().toISOString();
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)).toISOString();
}

/** Free, no-key GDELT 2.0 DOC API — last 48h of articles matching `query`. */
export async function fetchGdeltNews(query: string, gaps: string[]): Promise<GdeltArticle[] | null> {
  const key = `gdelt:${query}`;
  const result = await cachedOrFetch(key, 15 * 60 * 1000, async () => {
    const url =
      `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}` +
      `&mode=artlist&maxrecords=25&format=json&timespan=48h&sort=hybridrel`;
    const data = await fetchJson<GdeltDocResponse>(url);
    if (!data || !Array.isArray(data.articles)) {
      return null;
    }
    return data.articles.map((a) => ({
      headline: a.title,
      source: a.domain,
      url: a.url,
      datetime: parseGdeltDate(a.seendate),
      summary: a.title,
    }));
  });
  if (!result) {
    gaps.push(`GDELT 新聞查詢 (${query}) 取得失敗或回應為空`);
    return null;
  }
  return result;
}

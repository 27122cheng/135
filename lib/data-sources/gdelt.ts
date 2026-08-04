import { fetchFree } from "./free-source";
import { fetchJson } from "./http";

/**
 * GDELT publishes no rate limit for the DOC API. Self-imposed so a refresh
 * loop over 9 symbols can't look like a scraper.
 */
const GDELT_LIMIT = { perMinute: 30, perDay: 2000 };

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

/**
 * GDELT is frequently slow (several seconds) and answers a malformed or
 * overly complex query with a plain-text error rather than JSON, which the
 * shared fetch wrapper turns into null. So: a generous timeout, and a retry
 * with a single simplified term before giving up.
 */
async function queryGdelt(query: string): Promise<GdeltArticle[] | null> {
  const url =
    `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}` +
    `&mode=artlist&maxrecords=25&format=json&timespan=48h&sort=hybridrel`;
  const data = await fetchJson<GdeltDocResponse>(url, undefined, 15000);
  if (!data || !Array.isArray(data.articles)) return null;
  return data.articles.map((a) => ({
    headline: a.title,
    source: a.domain,
    url: a.url,
    datetime: parseGdeltDate(a.seendate),
    summary: a.title,
  }));
}

/** Falls back to the first bare term of the query, which GDELT always accepts. */
function simplify(query: string): string | null {
  const first = query.split(/\s+OR\s+/i)[0]?.replace(/"/g, "").trim();
  if (!first || first === query.replace(/"/g, "").trim()) return null;
  return first.includes(" ") ? `"${first}"` : first;
}

/** Free, no-key GDELT 2.0 DOC API — last 48h of articles matching `query`. */
export async function fetchGdeltNews(query: string, gaps: string[]): Promise<GdeltArticle[] | null> {
  const result = await fetchFree<GdeltArticle[]>({
    source: "gdelt",
    label: `GDELT 新聞查詢 (${query})`,
    key: `gdelt:${query}`,
    ttlMs: 15 * 60 * 1000,
    limit: GDELT_LIMIT,
    gaps,
    fn: async () => {
      const primary = await queryGdelt(query);
      if (primary && primary.length > 0) return primary;
      const simplified = simplify(query);
      if (simplified) {
        const retry = await queryGdelt(simplified);
        if (retry && retry.length > 0) return retry;
      }
      // Distinguish "worked, nothing matched" from "the call failed".
      return primary ?? null;
    },
  });
  if (!result) return null;
  if (result.value.length === 0) {
    gaps.push(`GDELT 近 48 小時查無 ${query} 相關新聞`);
  }
  return result.value;
}

import { fetchFree } from "./free-source";
import { fetchText } from "./http";
import type { GdeltArticle } from "./gdelt";

/**
 * 新聞備援 — Google News RSS, keyless, a different company than GDELT.
 *
 * The live deployment showed "GDELT 新聞 (Nasdaq 100) 取得失敗：連線失敗
 * (fetch failed)" and the whole 新聞面 dimension went dark with it, because
 * GDELT was the only headline source that needs no key (Finnhub's news needs
 * one). Google News serves a search RSS feed with no key and no login; it is
 * hosted by a different company on different infrastructure, so it fails
 * independently — the property the price chain already has and news lacked.
 *
 * RSS is XML, but the slice needed here (title / link / pubDate per item) is
 * regular enough for regex extraction; a full XML parser would be a dependency
 * for no extra information. Anything that doesn't parse is skipped, never
 * guessed at.
 */

const LIMIT = { perMinute: 15, perDay: 500 };

/** Google News titles end with " - Publisher"; the same name arrives in <source>. */
function splitTitle(raw: string): { headline: string; source: string | null } {
  const m = raw.match(/^(.*)\s+-\s+([^-]{2,60})$/);
  if (!m) return { headline: raw, source: null };
  return { headline: m[1].trim(), source: m[2].trim() };
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .trim();
}

/** Exported for tests — the parse is the part most likely to rot silently. */
export function parseGoogleNewsRss(xml: string): GdeltArticle[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  const articles: GdeltArticle[] = [];
  for (const item of items) {
    const title = item.match(/<title>([\s\S]*?)<\/title>/)?.[1];
    if (!title) continue;
    const link = item.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? "";
    const pubDate = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1];
    const sourceTag = item.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1];

    const at = pubDate ? new Date(pubDate) : null;
    const { headline, source } = splitTitle(decodeEntities(title));
    if (!headline) continue;
    articles.push({
      headline,
      source: decodeEntities(sourceTag ?? source ?? "news.google.com"),
      url: decodeEntities(link),
      // A headline without a date is still a headline; stamping "now" is fine
      // here because news recency only weights the digest, never a price.
      datetime: at && !Number.isNaN(at.getTime()) ? at.toISOString() : new Date().toISOString(),
      summary: headline,
    });
  }
  return articles;
}

/** Last 2 days of headlines matching `term`, or null when the feed is down. */
export async function fetchGoogleNews(term: string, gaps: string[]): Promise<GdeltArticle[] | null> {
  const result = await fetchFree<GdeltArticle[]>({
    source: "google-news",
    label: `Google News (${term})`,
    key: `gnews:${term}`,
    ttlMs: 15 * 60 * 1000,
    limit: LIMIT,
    gaps,
    fn: async () => {
      const url =
        `https://news.google.com/rss/search?q=${encodeURIComponent(`${term} when:2d`)}` +
        `&hl=en-US&gl=US&ceid=US:en`;
      const xml = await fetchText(
        url,
        { headers: { "user-agent": "Mozilla/5.0", accept: "application/rss+xml,application/xml,text/xml,*/*" } },
        10000,
      );
      if (!xml) return null;
      const articles = parseGoogleNewsRss(xml).slice(0, 25);
      return articles.length > 0 ? articles : null;
    },
  });
  return result?.value ?? null;
}

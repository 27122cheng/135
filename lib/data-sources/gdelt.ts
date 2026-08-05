import { fetchFree } from "./free-source";
import { describeFailure, fetchText, type HttpFailure } from "./http";

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

/**
 * Built from a string rather than written as a regex literal so the source file
 * itself stays free of control characters.
 */
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F]+", "g");

function parseGdeltDate(raw: string): string {
  // GDELT format: YYYYMMDDTHHMMSSZ
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return new Date().toISOString();
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)).toISOString();
}

/**
 * GDELT's `format=json` output is not reliably valid JSON. Article titles are
 * copied from the source page and regularly carry raw control characters, which
 * `JSON.parse` rejects outright — so a perfectly good 200 response was being
 * discarded as a failed fetch. Stripping them is safe here: they carry no
 * meaning in a headline.
 *
 * Exported for tests; this is the fix most likely to be undone by someone
 * tidying up, and it is not obvious from the outside why it exists.
 */
export function parseGdeltBody(body: string): GdeltDocResponse | { error: string } {
  const trimmed = body.trim();
  if (!trimmed) return { error: "空白回應" };
  // GDELT answers a query it dislikes with a plain-text sentence and HTTP 200.
  // That sentence is the most useful diagnostic there is, so surface it rather
  // than reporting a generic parse failure.
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return { error: trimmed.replace(/\s+/g, " ").slice(0, 160) };
  }
  const cleaned = trimmed.replace(CONTROL_CHARS, " ");
  try {
    return JSON.parse(cleaned) as GdeltDocResponse;
  } catch (e) {
    return { error: e instanceof Error ? e.message.slice(0, 120) : "JSON 解析失敗" };
  }
}

interface QueryOutcome {
  /** null means the call itself failed; [] means it worked and matched nothing. */
  articles: GdeltArticle[] | null;
  reason: string | null;
}

/**
 * GDELT is frequently slow (several seconds) and answers a malformed or
 * overly complex query with a plain-text error rather than JSON. So: a generous
 * timeout, a browser-shaped User-Agent (the default undici one gets throttled),
 * a tolerant parse, and a retry with a single simplified term before giving up.
 */
async function queryGdelt(query: string): Promise<QueryOutcome> {
  const url =
    `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}` +
    `&mode=artlist&maxrecords=25&format=json&timespan=48h&sort=hybridrel`;

  let failure: HttpFailure | null = null;
  const body = await fetchText(
    url,
    {
      headers: {
        // GDELT rate-limits aggressively by user agent and rejects some
        // default library agents outright.
        "user-agent": "Mozilla/5.0 (compatible; trade-signal/1.0)",
        accept: "application/json,text/plain,*/*",
      },
    },
    25000,
    (f) => {
      failure = f;
    },
  );
  if (body === null) return { articles: null, reason: describeFailure(failure) };

  const parsed = parseGdeltBody(body);
  if ("error" in parsed) return { articles: null, reason: parsed.error };

  // A valid response with no `articles` key is GDELT's way of saying "nothing
  // matched", not an error. Treating it as a failure made every quiet news day
  // look like a broken data source.
  if (!Array.isArray(parsed.articles)) return { articles: [], reason: null };

  return {
    articles: parsed.articles
      .filter((a) => a && typeof a.title === "string")
      .map((a) => ({
        headline: a.title,
        source: a.domain,
        url: a.url,
        datetime: parseGdeltDate(a.seendate),
        summary: a.title,
      })),
    reason: null,
  };
}

/** Falls back to the first bare term of the query, which GDELT always accepts. */
function simplify(query: string): string | null {
  const first = query.split(/\s+OR\s+/i)[0]?.replace(/"/g, "").trim();
  if (!first || first === query.replace(/"/g, "").trim()) return null;
  return first.includes(" ") ? `"${first}"` : first;
}

/** Free, no-key GDELT 2.0 DOC API — last 48h of articles matching `query`. */
export async function fetchGdeltNews(query: string, gaps: string[]): Promise<GdeltArticle[] | null> {
  // The full boolean query makes for an unreadable warning; the first term is
  // enough to identify which symbol's news failed.
  const short = query.split(/\s+OR\s+/i)[0].replace(/"/g, "").trim();
  let lastReason: string | null = null;

  const result = await fetchFree<GdeltArticle[]>({
    source: "gdelt",
    label: `GDELT 新聞 (${short})`,
    key: `gdelt:${query}`,
    ttlMs: 15 * 60 * 1000,
    limit: GDELT_LIMIT,
    gaps,
    diagnose: () => lastReason,
    fn: async () => {
      const primary = await queryGdelt(query);
      if (primary.articles && primary.articles.length > 0) return primary.articles;
      lastReason = primary.reason;

      const simplified = simplify(query);
      if (simplified) {
        const retry = await queryGdelt(simplified);
        if (retry.articles && retry.articles.length > 0) return retry.articles;
        // The simplified query is the better diagnostic: if even a single bare
        // term fails, the problem is GDELT or the network, not the query.
        if (retry.reason) lastReason = retry.reason;
      }
      // Distinguish "worked, nothing matched" from "the call failed".
      return primary.articles ?? null;
    },
  });
  if (!result) return null;
  if (result.value.length === 0) {
    gaps.push(`GDELT 近 48 小時查無「${short}」相關新聞`);
  }
  return result.value;
}

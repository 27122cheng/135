import { check, report, stubFetch } from "./_harness";
import { __resetCacheForTests } from "@/lib/data-sources/cache";
import { __resetQuotaForTests } from "@/lib/data-sources/quota";
import { parseGoogleNewsRss } from "@/lib/data-sources/google-news";
import { analyzeNews } from "@/lib/analysis/news";

/**
 * 「新聞層面無法載入」— GDELT was the only keyless headline source, and when
 * it died of "連線失敗 (fetch failed)" the whole 新聞面 dimension went dark.
 * Google News RSS is the backup: different company, different infrastructure,
 * asked only when the primary path returns nothing.
 */

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>news.google.com</title>
  <item>
    <title>Gold hits record high as Fed cut bets grow - Reuters</title>
    <link>https://news.google.com/rss/articles/abc1</link>
    <pubDate>Tue, 11 Aug 2026 09:30:00 GMT</pubDate>
    <source url="https://reuters.com">Reuters</source>
  </item>
  <item>
    <title><![CDATA[Dollar &amp; gold rally together - Bloomberg]]></title>
    <link>https://news.google.com/rss/articles/abc2</link>
    <pubDate>Tue, 11 Aug 2026 08:00:00 GMT</pubDate>
    <source url="https://bloomberg.com">Bloomberg</source>
  </item>
  <item>
    <title>Headline with no date or source</title>
    <link>https://news.google.com/rss/articles/abc3</link>
  </item>
</channel></rss>`;

async function main() {
  // ── the parse ───────────────────────────────────────────────────
  {
    const articles = parseGoogleNewsRss(RSS);
    check("all items are parsed", articles.length === 3, articles.length);
    check("the publisher suffix moves out of the headline",
      articles[0].headline === "Gold hits record high as Fed cut bets grow", articles[0].headline);
    check("the source is the publisher", articles[0].source === "Reuters", articles[0].source);
    check("the date is real", articles[0].datetime === "2026-08-11T09:30:00.000Z",
      articles[0].datetime);
    check("CDATA and entities are decoded",
      articles[1].headline === "Dollar & gold rally together", articles[1].headline);
    check("a dateless headline still parses", articles[2].headline.includes("no date"),
      articles[2]);

    check("garbage parses to nothing, not to invented articles",
      parseGoogleNewsRss("<html>not a feed</html>").length === 0);
  }

  // ── the fallback wiring ─────────────────────────────────────────
  {
    __resetCacheForTests();
    __resetQuotaForTests();
    // No AI keys: the lexicon path scores the backup headlines.
    delete process.env.GEMINI_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.FINNHUB_API_KEY;

    const seen = stubFetch((url) => {
      // The live failure mode: GDELT unreachable at the connection level.
      if (url.includes("gdeltproject")) throw new Error("fetch failed");
      if (url.includes("news.google.com")) return { status: 200, body: RSS };
      return { status: 500, body: "no" };
    });

    const gaps: string[] = [];
    const r = await analyzeNews('"gold price" OR gold', ["gold"], gaps);
    check("the dimension survives GDELT being down", r.digest !== null, r.digest);
    check("with the backup's headlines", r.digest?.headline_count === 3,
      r.digest?.headline_count);
    check("Google News was asked with the bare first term",
      seen.some((u) => u.includes("news.google.com") && u.includes("gold")), seen);

    // A working GDELT must keep the backup unasked — it costs a request and
    // adds nothing.
    __resetCacheForTests();
    __resetQuotaForTests();
    const seen2 = stubFetch((url) =>
      url.includes("gdeltproject")
        ? {
            status: 200,
            json: {
              articles: [
                { title: "Gold steady", domain: "r.com", url: "https://r.com/1", seendate: "20260811T090000Z" },
              ],
            },
          }
        : { status: 500, body: "no" },
    );
    await analyzeNews('"gold price" OR gold', ["gold"], []);
    check("a working GDELT keeps the backup unasked",
      !seen2.some((u) => u.includes("news.google.com")), seen2);
  }

  report("google news backup");
}

void main();

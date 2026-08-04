import { check, report, stubFetch } from "./_harness";
import { __resetCacheForTests } from "@/lib/data-sources/cache";
import { __resetQuotaForTests } from "@/lib/data-sources/quota";
import { analyzeNews } from "@/lib/analysis/news";

/**
 * The news digest: what the analysis read, what it concluded, and the rule that
 * a takeaway can only cite a headline we actually supplied.
 */

const headlines = [
  { title: "ECB signals rate cut", domain: "reuters.com", url: "https://r.com/1", seendate: "20260804T110000Z" },
  { title: "Euro slides on weak PMI", domain: "ft.com", url: "https://ft.com/2", seendate: "20260804T120000Z" },
  { title: "German factory orders rebound", domain: "bloomberg.com", url: "https://b.com/3", seendate: "20260804T130000Z" },
];

function aiReply(obj: unknown) {
  return { status: 200, json: { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] } };
}

function setup(aiBody: unknown, articles = headlines) {
  __resetCacheForTests();
  __resetQuotaForTests();
  process.env.GEMINI_API_KEY = "x";
  delete process.env.GROQ_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.FINNHUB_API_KEY;
  return stubFetch((url) =>
    url.includes("gdeltproject")
      ? { status: 200, json: { articles } }
      : aiReply(aiBody),
  );
}

async function main() {
  // A well-formed analysis.
  setup({
    score: -0.6,
    summary: "歐洲央行釋出降息訊號，歐元承壓。",
    key_points: [
      { point: "ECB 降息預期升溫，利差不利歐元", impact: "short", sources: [0] },
      { point: "德國工廠訂單回升，部分抵銷利空", impact: "long", sources: [2] },
    ],
  });
  const gaps: string[] = [];
  const r = await analyzeNews("euro OR ECB", ["euro"], gaps);
  check("digest is produced", r.digest !== null);
  check("score is carried through", r.digest?.score === -0.6, r.digest?.score);
  check("both key points survive", r.digest?.key_points.length === 2, r.digest?.key_points);
  check("impact directions are kept", r.digest?.key_points[0].impact === "short");
  check("citations are kept", r.digest?.key_points[0].sources[0] === 0);
  check("every headline is listed as a source", r.digest?.sources.length === 3, r.digest?.sources.length);
  check("sources carry a usable link", r.digest?.sources[0].url === "https://r.com/1");
  check("the analysing provider is named", r.digest?.analyzed_by === "gemini", r.digest?.analyzed_by);
  check("it still scores the 新聞面 dimension", r.biasItems.length === 1 && r.biasItems[0].direction === "short", r.biasItems);
  check("a strong score earns weight 2", r.biasItems[0].weight === 2, r.biasItems[0].weight);

  // THE INVARIANT: a citation pointing at a headline we never supplied is
  // dropped, so a takeaway can't be attributed to an article that doesn't exist.
  setup({
    score: 0.2,
    summary: "s",
    key_points: [
      { point: "引用了不存在的第 99 則", impact: "long", sources: [99, 0] },
      { point: "引用了負數", impact: "short", sources: [-1] },
    ],
  });
  const r2 = await analyzeNews("euro OR ECB", ["euro"], []);
  check("out-of-range citation dropped", r2.digest?.key_points[0].sources.length === 1, r2.digest?.key_points[0]);
  check("the valid citation survives", r2.digest?.key_points[0].sources[0] === 0);
  check("a negative index is dropped", r2.digest?.key_points[1].sources.length === 0, r2.digest?.key_points[1]);
  check("the point itself is still shown", r2.digest?.key_points.length === 2);

  // Malformed key points are skipped, not rendered as blanks.
  setup({
    score: 0,
    summary: "s",
    key_points: [
      { point: "", impact: "long", sources: [] },
      { point: "  ", impact: "short", sources: [] },
      { point: "有效重點", impact: "banana", sources: "not-an-array" },
    ],
  });
  const r3 = await analyzeNews("euro OR ECB", ["euro"], []);
  check("empty points are skipped", r3.digest?.key_points.length === 1, r3.digest?.key_points);
  check("an unknown impact falls back to neutral", r3.digest?.key_points[0].impact === "neutral");
  check("a non-array sources field becomes empty", r3.digest?.key_points[0].sources.length === 0);

  // No AI configured: the lexicon path still returns the headlines to read.
  __resetCacheForTests();
  __resetQuotaForTests();
  for (const k of ["GEMINI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"]) {
    delete process.env[k];
  }
  stubFetch(() => ({ status: 200, json: { articles: headlines } }));
  const gaps4: string[] = [];
  const r4 = await analyzeNews("euro OR ECB", ["euro"], gaps4);
  check("a digest is still produced with no AI", r4.digest !== null);
  check("headlines are still listed", r4.digest?.sources.length === 3, r4.digest?.sources.length);
  check("keyword scoring claims no takeaways", r4.digest?.key_points.length === 0, r4.digest?.key_points);
  check("it is labelled as not-AI", r4.digest?.analyzed_by.includes("非 AI") === true, r4.digest?.analyzed_by);

  // No headlines at all: no digest, and no duplicated warning.
  __resetCacheForTests();
  __resetQuotaForTests();
  stubFetch(() => ({ status: 200, json: {} }));
  const gaps5: string[] = [];
  const r5 = await analyzeNews("euro OR ECB", ["euro"], gaps5);
  check("no headlines means no digest", r5.digest === null, r5.digest);
  check("only GDELT reports the absence", gaps5.filter((g) => g.includes("查無")).length === 1, gaps5);

  report("news digest");
}

void main();

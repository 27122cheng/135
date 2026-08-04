import { check, report, stubFetch } from "./_harness";
import { __resetCacheForTests } from "@/lib/data-sources/cache";
import { __resetQuotaForTests } from "@/lib/data-sources/quota";
import { fetchGdeltNews } from "@/lib/data-sources/gdelt";

const QUERY = 'euro OR "European Central Bank" OR eurozone';

const article = {
  title: "ECB holds rates",
  domain: "reuters.com",
  url: "https://reuters.com/x",
  seendate: "20260804T113000Z",
};

async function main() {
  // A real result.
  __resetCacheForTests();
  __resetQuotaForTests();
  stubFetch(() => ({ status: 200, json: { articles: [article] } }));
  const gaps1: string[] = [];
  const ok = await fetchGdeltNews(QUERY, gaps1);
  check("parses articles", ok?.length === 1, ok);
  check("converts GDELT's date format", ok?.[0].datetime === "2026-08-04T11:30:00.000Z", ok?.[0]);
  check("a successful query reports nothing", gaps1.length === 0, gaps1);

  // The bug this file exists for: GDELT answers a zero-result query with valid
  // JSON that simply has no `articles` key. That is "nothing matched", not a
  // broken source, and must not be reported as a fetch failure.
  __resetCacheForTests();
  __resetQuotaForTests();
  stubFetch(() => ({ status: 200, json: {} }));
  const gaps2: string[] = [];
  const empty = await fetchGdeltNews(QUERY, gaps2);
  check("no-results is an empty array, not null", Array.isArray(empty) && empty.length === 0, empty);
  check("it is reported as 查無, not 取得失敗", gaps2.some((g) => g.includes("查無")), gaps2);
  check("it is not reported as a failure", !gaps2.some((g) => g.includes("取得失敗")), gaps2);
  check("the warning names the term, not the whole query", gaps2.some((g) => g.includes("euro") && !g.includes("OR")), gaps2);

  // A genuine transport failure still reports as one.
  __resetCacheForTests();
  __resetQuotaForTests();
  stubFetch(() => ({ status: 500, body: "upstream error" }));
  const gaps3: string[] = [];
  const failed = await fetchGdeltNews(QUERY, gaps3);
  check("a 500 returns null", failed === null, failed);
  check("a 500 is reported as a failure", gaps3.some((g) => g.includes("取得失敗")), gaps3);

  // Non-JSON (GDELT answers malformed queries with plain text) is a failure.
  __resetCacheForTests();
  __resetQuotaForTests();
  stubFetch(() => ({ status: 200, body: "Your query was too short" }));
  const gaps4: string[] = [];
  check("a plain-text error is a failure", (await fetchGdeltNews(QUERY, gaps4)) === null);

  // The boolean query failing falls back to the first bare term.
  __resetCacheForTests();
  __resetQuotaForTests();
  const seen = stubFetch((url) =>
    url.includes("European") ? { status: 500, body: "no" } : { status: 200, json: { articles: [article] } },
  );
  const gaps5: string[] = [];
  const retried = await fetchGdeltNews(QUERY, gaps5);
  check("falls back to the simplified term", retried?.length === 1, retried);
  check("both queries were attempted", seen.length === 2, seen.length);

  report("gdelt");
}

void main();

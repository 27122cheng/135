import { check, report, stubFetch } from "./_harness";
import { __resetCacheForTests } from "@/lib/data-sources/cache";
import { __resetQuotaForTests } from "@/lib/data-sources/quota";

/**
 * 「為什麼還是休市中」— the Tuesday the fix for the previous Tuesday failed.
 *
 * The market-hours gate had been taught to require two witnesses: the quote
 * *and* the candles both stale before calling a weekday closed. On the live
 * deployment both witnesses went stale together — because they were the same
 * witness. The candle "proxy" wraps the same Yahoo upstream as the direct
 * quote, and when Yahoo froze this deployment's data at the previous Thursday
 * it served perfectly valid 200s, so the fallback chain never ran, Stooq sat
 * unused, and nine open instruments read 休市中 for days.
 *
 * Two properties pinned here:
 *  - a 200 whose newest bar is ancient is treated as a failure mid-chain, so
 *    an actually independent source gets to answer;
 *  - the latest-price lookup has a non-Yahoo fallback (Stooq's quote CSV), so
 *    a Yahoo-side freeze can no longer take out every price at once.
 */

const DAY = 24 * 60 * 60 * 1000;
const sec = (ms: number) => Math.floor(ms / 1000);

/** A syntactically perfect Yahoo chart answer whose bars stop at `endMs`. */
function chartJson(endMs: number, bars: number, close: number) {
  const timestamp = Array.from({ length: bars }, (_, i) => sec(endMs - (bars - 1 - i) * DAY));
  const closes = timestamp.map(() => close);
  return {
    chart: {
      result: [
        {
          timestamp,
          meta: { regularMarketTime: timestamp[timestamp.length - 1] },
          indicators: {
            quote: [
              {
                open: closes,
                high: closes.map((c) => c + 1),
                low: closes.map((c) => c - 1),
                close: closes,
                volume: closes.map(() => 100),
              },
            ],
          },
        },
      ],
    },
  };
}

function stooqDailyCsv(now: number): string {
  const d = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return (
    "Date,Open,High,Low,Close,Volume\n" +
    `${d(now - 2 * DAY)},4100.5,4130.2,4090.1,4120.4,0\n` +
    `${d(now - DAY)},4120.4,4150.0,4110.0,4145.6,0\n`
  );
}

async function main() {
  const { fetchOHLCV } = await import("@/lib/data-sources/ohlcv");
  const { fetchLatestPrice } = await import("@/lib/data-sources/yfinance");
  const { COMMODITIES } = await import("@/types/signal");
  const gold = COMMODITIES.find((c) => c.symbol === "XAUUSD")!;
  const now = Date.now();
  delete process.env.FINNHUB_API_KEY;

  // ── a frozen 200 is a failure, and the chain keeps going ────────
  {
    __resetCacheForTests();
    __resetQuotaForTests();
    stubFetch((url) =>
      url.includes("query1.finance")
        ? { status: 200, json: chartJson(now - 10 * DAY, 30, 4300.7) }
        : url.includes("stooq.com")
          ? { status: 200, body: stooqDailyCsv(now) }
          : { status: 500, body: "no" },
    );
    const gaps: string[] = [];
    const r = await fetchOHLCV(gold, "D1", gaps);
    check("week-old bars in a 200 do not win the chain", r?.source === "stooq", r?.source);
    check("the independent source's data is served", r?.candles.at(-1)?.close === 4145.6,
      r?.candles.at(-1));
    check("and it is not stale", r?.stale === false, r?.stale);
  }

  // ── but a frozen answer still beats no answer ───────────────────
  {
    __resetCacheForTests();
    __resetQuotaForTests();
    stubFetch((url) =>
      url.includes("query1.finance")
        ? { status: 200, json: chartJson(now - 10 * DAY, 30, 4300.7) }
        : { status: 500, body: "no" },
    );
    const gaps: string[] = [];
    const r = await fetchOHLCV(gold, "D1", gaps);
    check("with every fallback down the frozen copy is the last resort",
      r?.source === "yfinance-proxy", r?.source);
    check("labelled stale", r?.stale === true, r?.stale);
    check("and the gap says the data is not live",
      gaps.some((g) => g.includes("非即時")), gaps);
  }

  // ── the quote has a second company to ask ───────────────────────
  {
    __resetCacheForTests();
    __resetQuotaForTests();
    const at = new Date(now - 5 * 60 * 1000);
    const quoteCsv =
      "Symbol,Date,Time,Open,High,Low,Close,Volume\n" +
      `XAUUSD,${at.toISOString().slice(0, 10)},${at.toISOString().slice(11, 19)},4340,4350,4330,4343.88,0\n`;
    stubFetch((url) =>
      url.includes("query1.finance")
        ? { status: 200, json: chartJson(now - 5 * DAY, 30, 4300.7) }
        : url.includes("stooq.com/q/l/")
          ? { status: 200, body: quoteCsv }
          : { status: 500, body: "no" },
    );
    const gaps: string[] = [];
    const price = await fetchLatestPrice(gold.yfinanceSymbol, gaps, gold.stooqSymbol);
    check("a stale direct quote hands over to Stooq", price?.source === "stooq", price);
    check("with Stooq's price, not Yahoo's frozen one", price?.price === 4343.88, price?.price);
    check("and a believable age", (price?.ageMinutes ?? 999) < 60, price?.ageMinutes);
  }

  // ── one transient network error does not lose the scan ──────────
  {
    const { fetchText } = await import("@/lib/data-sources/http");
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) throw new Error("fetch failed");
      return {
        ok: true,
        status: 200,
        text: async () => "hello",
        json: async () => ({}),
      } as unknown as Response;
    }) as typeof fetch;
    const text = await fetchText("https://example.com/x");
    check("a connection-level failure is retried once", text === "hello" && calls === 2,
      { text, calls });
  }

  // ── stooq.pl is the spare key to stooq.com ──────────────────────
  {
    __resetCacheForTests();
    __resetQuotaForTests();
    const at = new Date(now - 5 * 60 * 1000);
    const quoteCsv =
      "Symbol,Date,Time,Open,High,Low,Close,Volume\n" +
      `XAUUSD,${at.toISOString().slice(0, 10)},${at.toISOString().slice(11, 19)},4340,4350,4330,4343.88,0\n`;
    stubFetch((url) => {
      // The live failure mode: stooq.com unreachable at the connection level.
      if (url.includes("stooq.com")) throw new Error("fetch failed");
      if (url.includes("stooq.pl/q/l/")) return { status: 200, body: quoteCsv };
      if (url.includes("finance.yahoo.com"))
        return { status: 200, json: chartJson(now - 5 * DAY, 30, 4300.7) };
      return { status: 500, body: "no" };
    });
    const gaps: string[] = [];
    const price = await fetchLatestPrice(gold.yfinanceSymbol, gaps, gold.stooqSymbol);
    check("stooq.pl answers when stooq.com is unreachable",
      price?.source === "stooq" && price.price === 4343.88, price);
  }

  // ── query2 rescues a frozen query1 ──────────────────────────────
  {
    __resetCacheForTests();
    __resetQuotaForTests();
    stubFetch((url) =>
      url.includes("query2.finance")
        ? { status: 200, json: chartJson(now - 6 * 60 * 60 * 1000, 30, 4351.2) }
        : url.includes("query1.finance")
          ? { status: 200, json: chartJson(now - 10 * DAY, 30, 4300.7) }
          : { status: 500, body: "no" },
    );
    const gaps: string[] = [];
    const r = await fetchOHLCV(gold, "D1", gaps);
    check("the second Yahoo host rescues a frozen first one",
      r?.source === "yfinance-proxy", r?.source);
    check("with the fresh host's data", r?.candles.at(-1)?.close === 4351.2,
      r?.candles.at(-1));
  }

  // ── the third witness answers when both quote sources are dark ──
  {
    __resetCacheForTests();
    __resetQuotaForTests();
    delete process.env.FRED_API_KEY;
    const nas = COMMODITIES.find((c) => c.symbol === "NAS100")!;
    const yesterday = new Date(now - DAY).toISOString().slice(0, 10);
    stubFetch((url) => {
      if (url.includes("stooq")) throw new Error("fetch failed");
      if (url.includes("finance.yahoo.com"))
        return { status: 200, json: chartJson(now - 5 * DAY, 30, 23100.2) };
      if (url.includes("fred.stlouisfed.org"))
        return { status: 200, body: `DATE,NASDAQ100\n${yesterday},23750.5\n` };
      return { status: 500, body: "no" };
    });
    const gaps: string[] = [];
    const price = await fetchLatestPrice(nas.yfinanceSymbol, gaps, nas.stooqSymbol, nas.symbol);
    check("FRED's close beats the frozen quote", price?.source === "fred", price);
    check("yesterday's real close, not last Thursday's",
      price?.price === 23750.5, price?.price);
    // Beyond the live-quote freshness bound (3h) whatever the wall clock says:
    // yesterday's 20:00Z close is at least 4h old at midnight and grows from
    // there. The old 12h bound made this test fail every UTC morning.
    check("with its honest age", (price?.ageMinutes ?? 0) > 3 * 60, price?.ageMinutes);
  }

  // ── Stooq saying "no data" is not a price ───────────────────────
  {
    __resetCacheForTests();
    __resetQuotaForTests();
    stubFetch((url) =>
      url.includes("query1.finance")
        ? { status: 200, json: chartJson(now - 5 * DAY, 30, 4300.7) }
        : url.includes("stooq.com/q/l/")
          ? { status: 200, body: "Symbol,Date,Time,Open,High,Low,Close,Volume\nXAUUSD,N/D,N/D,N/D,N/D,N/D,N/D,N/D\n" }
          : { status: 500, body: "no" },
    );
    const gaps: string[] = [];
    const price = await fetchLatestPrice(gold.yfinanceSymbol, gaps, gold.stooqSymbol);
    check("an N/D row is rejected, not parsed as a price",
      price !== null && price.source !== "stooq", price?.source);
    check("the labelled old price survives as the fallback",
      price?.price === 4300.7, price?.price);
    check("with its true age, not a flattering one",
      (price?.ageMinutes ?? 0) > 3 * 60, price?.ageMinutes);
  }

  report("frozen feed");
}

void main();

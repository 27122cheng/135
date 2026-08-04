import { check, report, stubFetch } from "./_harness";
import { __resetCacheForTests } from "@/lib/data-sources/cache";
import { __resetQuotaForTests } from "@/lib/data-sources/quota";

const STOOQ = `Date,Open,High,Low,Close,Volume
2026-07-30,4100.5,4130.2,4090.1,4120.4,0
2026-07-31,4120.4,4150.0,4110.0,4145.6,0
`;

/**
 * The source chain: yfinance proxy → Finnhub → Stooq. The property that
 * matters is that a *working* fallback reports no gap, while total failure
 * reports exactly one aggregated reason — never a fabricated candle.
 */
async function main() {
  const { fetchOHLCV } = await import("@/lib/data-sources/ohlcv");
  const { COMMODITIES } = await import("@/types/signal");
  const gold = COMMODITIES.find((c) => c.symbol === "XAUUSD")!;

  // Yahoo refuses (429, as it does for datacenter IPs); Stooq answers.
  __resetCacheForTests();
  __resetQuotaForTests();
  stubFetch((url) =>
    url.includes("stooq.com")
      ? { status: 200, body: STOOQ }
      : { status: 429, body: "rate limited" },
  );

  const gaps: string[] = [];
  const r = await fetchOHLCV(gold, "D1", gaps);
  check("falls through to Stooq", r?.source === "stooq", r?.source);
  check("parses both rows", r?.candles.length === 2, r?.candles.length);
  check("last close is real", r?.candles.at(-1)?.close === 4145.6, r?.candles.at(-1));
  check("data is not marked stale", r?.stale === false);
  // A working fallback must not nag about the source that didn't answer.
  check("a working fallback reports no gap", gaps.length === 0, gaps);

  // Every source down: one aggregated gap, and no invented candles.
  __resetCacheForTests();
  __resetQuotaForTests();
  stubFetch(() => ({ status: 500, body: "boom" }));
  const gaps2: string[] = [];
  const r2 = await fetchOHLCV(gold, "D1", gaps2);
  check("total failure returns null", r2 === null, r2);
  check("total failure is reported once", gaps2.some((g) => g.includes("所有來源皆失敗")), gaps2);

  // W1 works the same way; H4 has no Stooq equivalent so it can only fail.
  __resetCacheForTests();
  __resetQuotaForTests();
  stubFetch((url) =>
    url.includes("stooq.com") ? { status: 200, body: STOOQ } : { status: 429, body: "no" },
  );
  const gaps3: string[] = [];
  const h4 = await fetchOHLCV(gold, "H4", gaps3);
  check("H4 cannot be served by Stooq", h4 === null, h4);
  check("H4 failure says why", gaps3.some((g) => g.includes("Stooq 不支援 H4")), gaps3);

  // The exception to "a working source reports no gap": stale data must always
  // be announced. Warm the cache, let it expire, then block the network.
  __resetCacheForTests();
  __resetQuotaForTests();
  const { setCached } = await import("@/lib/data-sources/cache");
  setCached(
    "yahoo:GC=F:1d:1y",
    [{ time: "2026-07-31T00:00:00.000Z", open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }],
    // Already expired, but still inside the stale window.
    -1000,
  );
  stubFetch(() => ({ status: 500, body: "down" }));
  const gaps4: string[] = [];
  const stale = await fetchOHLCV(gold, "D1", gaps4);
  check("serves the stale copy rather than nothing", stale?.candles.length === 1, stale);
  check("marks it stale", stale?.stale === true, stale?.stale);
  check("announces staleness even on success", gaps4.some((g) => g.includes("stale")), gaps4);

  report("ohlcv chain");
}

void main();

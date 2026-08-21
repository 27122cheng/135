/* Quota tracking, exponential backoff, the stale tier, and H4 resampling. */
import { tryConsume, recordFailure, recordSuccess, __resetQuotaForTests, quotaSnapshot } from "@/lib/data-sources/quota";
import { fetchFree } from "@/lib/data-sources/free-source";
import { CANDLE_STALE_MS, DEFAULT_STALE_MS, __resetCacheForTests } from "@/lib/data-sources/cache";
import { jsonSchema, textSchema } from "@/lib/ai/provider";
import { resampleTo4h } from "@/lib/data-sources/yfinance";

import { check, report } from "./_harness";

// ---------- quota ----------
__resetQuotaForTests();
{
  const limit = { perMinute: 3 };
  const r = [1, 2, 3, 4].map(() => tryConsume("t1", limit).ok);
  check("perMinute allows exactly N then blocks", JSON.stringify(r) === "[true,true,true,false]", r);
}
{
  const limit = { perDay: 2 };
  const r = [1, 2, 3].map(() => tryConsume("t2", limit).ok);
  check("perDay allows exactly N then blocks", JSON.stringify(r) === "[true,true,false]", r);
  const d = tryConsume("t2", limit);
  check("blocked decision carries a reason", !d.ok && d.reason.includes("今日額度"), d);
}
{
  // Exponential backoff: each consecutive failure at least doubles the wait.
  recordFailure("t3");
  const first = tryConsume("t3", {});
  const firstWait = first.ok ? 0 : first.retryAfterMs;
  __resetQuotaForTests();
  recordFailure("t4");
  recordFailure("t4");
  recordFailure("t4");
  const third = tryConsume("t4", {});
  const thirdWait = third.ok ? 0 : third.retryAfterMs;
  check("backoff blocks after a failure", firstWait > 0, firstWait);
  check("backoff grows exponentially", thirdWait >= firstWait * 3, { firstWait, thirdWait });
}
{
  __resetQuotaForTests();
  recordFailure("t5");
  recordFailure("t5");
  recordSuccess("t5");
  check("success clears backoff", tryConsume("t5", {}).ok);
}
{
  __resetQuotaForTests();
  tryConsume("t6", { perMinute: 10 });
  tryConsume("t6", { perMinute: 10 });
  const snap = quotaSnapshot();
  check("snapshot counts usage", snap.t6.usedToday === 2 && snap.t6.usedLastMinute === 2, snap.t6);
}

// ---------- fetchFree: the stale contract ----------
async function freeSourceTests() {
  __resetQuotaForTests();
  __resetCacheForTests();

  // 1. live call caches
  let calls = 0;
  const gaps1: string[] = [];
  const a = await fetchFree<string>({
    source: "s1", label: "S1", key: "k1", ttlMs: 50, limit: { perMinute: 10 },
    gaps: gaps1, fn: async () => { calls++; return "fresh"; },
  });
  check("live call returns fresh", a?.value === "fresh" && a.stale === false, a);
  check("live call adds no gap", gaps1.length === 0, gaps1);

  // 2. second call inside TTL is served from cache without spending quota
  const before = quotaSnapshot().s1.usedToday;
  const b = await fetchFree<string>({
    source: "s1", label: "S1", key: "k1", ttlMs: 50, limit: { perMinute: 10 },
    gaps: gaps1, fn: async () => { calls++; return "second"; },
  });
  check("fresh cache hit does not refetch", b?.value === "fresh" && calls === 1, { b, calls });
  check("fresh cache hit spends no quota", quotaSnapshot().s1.usedToday === before);

  // 3. past TTL + quota exhausted -> stale copy, clearly labelled
  await new Promise((r) => setTimeout(r, 60));
  __resetQuotaForTests();
  tryConsume("s1", { perMinute: 1 }); // burn the single allowed call
  const gaps3: string[] = [];
  const c = await fetchFree<string>({
    source: "s1", label: "S1", key: "k1", ttlMs: 50, limit: { perMinute: 1 },
    gaps: gaps3, fn: async () => { calls++; return "should-not-run"; },
  });
  check("over quota serves stale value", c?.value === "fresh" && c.stale === true, c);
  check("over quota does not call upstream", calls === 1, calls);
  check("stale is reported to the user", gaps3.some((g) => g.includes("stale")), gaps3);

  // 4. upstream failure with a stale copy available -> stale, not null
  __resetQuotaForTests();
  const gaps4: string[] = [];
  const d = await fetchFree<string>({
    source: "s1", label: "S1", key: "k1", ttlMs: 50, limit: { perMinute: 10 },
    gaps: gaps4, fn: async () => null,
  });
  check("failure falls back to stale", d?.value === "fresh" && d.stale === true, d);

  // 5. failure with no cache at all -> null AND a recorded reason
  __resetQuotaForTests();
  __resetCacheForTests();
  const gaps5: string[] = [];
  const e = await fetchFree<string>({
    source: "s2", label: "S2", key: "k2", ttlMs: 50, limit: { perMinute: 10 },
    gaps: gaps5, fn: async () => null,
  });
  check("total failure returns null", e === null, e);
  check("total failure records why", gaps5.length === 1 && gaps5[0].includes("S2"), gaps5);

  // 6. a failing source backs off: the second attempt never reaches fn
  let calls2 = 0;
  const gaps6: string[] = [];
  await fetchFree<string>({
    source: "s3", label: "S3", key: "k3", ttlMs: 50, limit: { perMinute: 10 },
    gaps: gaps6, fn: async () => { calls2++; return null; },
  });
  await fetchFree<string>({
    source: "s3", label: "S3", key: "k3", ttlMs: 50, limit: { perMinute: 10 },
    gaps: gaps6, fn: async () => { calls2++; return null; },
  });
  check("backoff prevents immediate retry", calls2 === 1, calls2);

  // 7. the stale window is a parameter, and candles get a longer one.
  //
  // XAUUSD's proxy and Stooq both failed for over a day; the moment the last
  // good series crossed the default 24h window, every timeframe reported
  // 「無可用快取」at once and ATR/technicals/structure all went blind. A
  // candle series days old still carries what those are computed from, so
  // candle fetches pass CANDLE_STALE_MS and survive a multi-day outage.
  __resetQuotaForTests();
  __resetCacheForTests();
  const shortWin: Parameters<typeof fetchFree<string>>[0] = {
    source: "s7", label: "S7", key: "k7", ttlMs: 10, staleMs: 30,
    limit: { perMinute: 10 }, gaps: [], fn: async () => "series",
  };
  await fetchFree<string>(shortWin);
  await new Promise((r) => setTimeout(r, 60)); // past ttl AND past the window
  const gone = await fetchFree<string>({ ...shortWin, gaps: [], fn: async () => null });
  check("past its stale window the copy is unservable", gone === null, gone);

  __resetQuotaForTests();
  __resetCacheForTests();
  const longWin: Parameters<typeof fetchFree<string>>[0] = {
    source: "s8", label: "S8", key: "k8", ttlMs: 10, staleMs: 60_000,
    limit: { perMinute: 10 }, gaps: [], fn: async () => "series",
  };
  await fetchFree<string>(longWin);
  await new Promise((r) => setTimeout(r, 60));
  const keptGaps: string[] = [];
  const kept = await fetchFree<string>({ ...longWin, gaps: keptGaps, fn: async () => null });
  check("a longer window still serves the old copy, labelled",
    kept?.value === "series" && kept.stale === true && keptGaps.some((g) => g.includes("stale")),
    { kept, keptGaps });

  check("candle series get a week; the default stays a day",
    CANDLE_STALE_MS === 7 * 24 * 60 * 60 * 1000 &&
    DEFAULT_STALE_MS === 24 * 60 * 60 * 1000,
    { CANDLE_STALE_MS, DEFAULT_STALE_MS });
}

// ---------- response schemas ----------
{
  const s = jsonSchema<{ score: number }>("t", "", (v) =>
    typeof v.score === "number" ? { score: v.score } : null,
  );
  check("json schema parses bare object", s.parse('{"score": 0.5}')?.score === 0.5);
  check(
    "json schema digs out of a markdown fence",
    s.parse('Sure!\n```json\n{"score": -0.3}\n```')?.score === -0.3,
  );
  check("json schema rejects wrong type", s.parse('{"score": "high"}') === null);
  check("json schema rejects prose", s.parse("I think it is bullish.") === null);
  check("json schema rejects an array", s.parse("[1,2,3]") === null);
  const t = textSchema("");
  check("text schema rejects empty", t.parse("   ") === null);
  check("text schema trims", t.parse("  hi  ") === "hi");
}

// ---------- H4 resampling ----------
{
  const hourly = Array.from({ length: 8 }, (_, i) => ({
    time: new Date(Date.UTC(2026, 0, 1, i)).toISOString(),
    open: 10 + i, high: 20 + i, low: 5 + i, close: 15 + i, volume: 100,
  }));
  const out = resampleTo4h(hourly);
  check("8 hourly candles -> 2 four-hour candles", out.length === 2, out.length);
  check("bucket opens at the first hour's open", out[0].open === 10, out[0]);
  check("bucket closes at the last hour's close", out[0].close === 18, out[0]);
  check("bucket high is the max", out[0].high === 23, out[0]);
  check("bucket low is the min", out[0].low === 5, out[0]);
  check("bucket volume sums", out[0].volume === 400, out[0]);
  check("buckets align to UTC 0/4", out[0].time.includes("T00:00") && out[1].time.includes("T04:00"), out.map((c) => c.time));
}

void freeSourceTests().then(() => report("free-stack"));

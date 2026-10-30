import { check, report, stubFetch } from "./_harness";
import { __resetCacheForTests } from "@/lib/data-sources/cache";
import { __resetQuotaForTests, backoffRemainingMs } from "@/lib/data-sources/quota";

/**
 * 深度歷史的替代代號 — gold's lab history falls back to the COMEX
 * continuous contract when Yahoo's spot ticker comes back empty.
 */

function yahoo(n: number, start = Date.UTC(2016, 0, 1)) {
  const ts: number[] = [];
  const o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [], v: number[] = [];
  for (let i = 0; i < n; i++) {
    ts.push(Math.floor((start + i * 86_400_000) / 1000));
    const px = 1800 + Math.sin(i / 9) * 40 + i * 0.1;
    o.push(px); h.push(px + 6); l.push(px - 6); c.push(px + 1); v.push(1000);
  }
  return { chart: { result: [{ timestamp: ts, indicators: { quote: [{ open: o, high: h, low: l, close: c, volume: v }] } }] } };
}
const empty = { chart: { result: [{ timestamp: [], indicators: { quote: [{}] } }] } };

async function main() {
  const { fetchDeepD1, fetchDeepH4 } = await import("@/lib/data-sources/deep-history");
  const { COMMODITIES } = await import("@/types/signal");
  const gold = COMMODITIES.find((c) => c.symbol === "XAUUSD")!;
  const eur = COMMODITIES.find((c) => c.symbol === "EURUSD")!;

  // Spot ticker empty, futures alias answers with a decade.
  __resetCacheForTests(); __resetQuotaForTests();
  let seen = stubFetch((url) => {
    if (url.includes("XAUUSD%3DX") || url.includes("XAUUSD=X")) return { status: 200, json: empty };
    if (url.includes("GC%3DF") || url.includes("GC=F")) return { status: 200, json: yahoo(2500) };
    return { status: 429, body: "no" };
  });
  const gaps: string[] = [];
  const d1 = await fetchDeepD1(gold, gaps);
  check("gold's deep D1 falls back to GC=F", d1 !== null && d1.candles.length === 2500, d1?.candles.length);
  check("still reported as the Yahoo leg", d1?.source === "yfinance-proxy", d1?.source);
  check("and says so, with the basis caveat",
    gaps.some((g) => g.includes("GC=F") && g.includes("基差")), gaps);
  check("the alias was actually requested", seen.some((u) => u.includes("GC%3DF") || u.includes("GC=F")), seen);
  check("an answered-but-empty chart did not put Yahoo into backoff", backoffRemainingMs("yahoo") === 0);

  // A refused primary (429 = transport-level) DOES back Yahoo off; the deep
  // chain waits it out instead of firing the alias into the refusal.
  __resetCacheForTests(); __resetQuotaForTests();
  const t0 = Date.now();
  seen = stubFetch((url) => {
    if (url.includes("XAUUSD%3DX") || url.includes("XAUUSD=X")) return { status: 429, body: "rate limited" };
    if (url.includes("GC%3DF") || url.includes("GC=F")) return { status: 200, json: yahoo(2400) };
    return { status: 429, body: "no" };
  });
  const gapsR: string[] = [];
  const refused = await fetchDeepD1(gold, gapsR);
  check("after a refused primary the alias still gets its turn", refused?.candles.length === 2400, refused?.candles.length);
  check("because the chain waited out the backoff", Date.now() - t0 >= 2000, Date.now() - t0);

  // Spot ticker healthy: the alias is never asked for.
  __resetCacheForTests(); __resetQuotaForTests();
  seen = stubFetch((url) => {
    if (url.includes("XAUUSD%3DX") || url.includes("XAUUSD=X")) return { status: 200, json: yahoo(2600) };
    return { status: 500, body: "should not be called" };
  });
  const gaps2: string[] = [];
  const ok = await fetchDeepD1(gold, gaps2);
  check("a healthy spot series is used as-is", ok?.candles.length === 2600, ok?.candles.length);
  check("and the futures alias is not requested", !seen.some((u) => u.includes("GC%3DF") || u.includes("GC=F")), seen);
  check("no alias note", !gaps2.some((g) => g.includes("GC=F")), gaps2);

  // A short spot series is beaten by a longer alias series.
  __resetCacheForTests(); __resetQuotaForTests();
  stubFetch((url) => {
    if (url.includes("XAUUSD%3DX") || url.includes("XAUUSD=X")) return { status: 200, json: yahoo(300) };
    if (url.includes("GC%3DF") || url.includes("GC=F")) return { status: 200, json: yahoo(2000) };
    return { status: 429, body: "no" };
  });
  const gaps3: string[] = [];
  const longer = await fetchDeepD1(gold, gaps3);
  check("the longer series wins", longer?.candles.length === 2000, longer?.candles.length);

  // H4 takes the same road.
  __resetCacheForTests(); __resetQuotaForTests();
  stubFetch((url) => {
    if (url.includes("XAUUSD%3DX") || url.includes("XAUUSD=X")) return { status: 200, json: empty };
    if ((url.includes("GC%3DF") || url.includes("GC=F")) && url.includes("range=730d")) {
      // 60m bars, 700 days → resampled to 4h
      const ts: number[] = []; const o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [], v: number[] = [];
      const start = Date.UTC(2025, 0, 1);
      for (let i = 0; i < 700 * 24; i++) {
        ts.push(Math.floor((start + i * 3_600_000) / 1000));
        const px = 2000 + Math.sin(i / 50) * 20; o.push(px); h.push(px + 2); l.push(px - 2); c.push(px + 0.5); v.push(10);
      }
      return { status: 200, json: { chart: { result: [{ timestamp: ts, indicators: { quote: [{ open: o, high: h, low: l, close: c, volume: v }] } }] } } };
    }
    return { status: 429, body: "no" };
  });
  const gaps4: string[] = [];
  const h4 = await fetchDeepH4(gold, gaps4);
  check("gold's deep H4 falls back to GC=F too", h4 !== null && h4.candles.length > 600, h4?.candles.length);
  check("with the alias note", gaps4.some((g) => g.includes("GC=F")), gaps4);

  // A symbol with no alias behaves exactly as before.
  __resetCacheForTests(); __resetQuotaForTests();
  seen = stubFetch(() => ({ status: 429, body: "no" }));
  const gaps5: string[] = [];
  const none = await fetchDeepD1(eur, gaps5);
  check("no alias for EURUSD: total failure stays a failure", none === null);
  check("and only its own ticker was asked", seen.every((u) => !u.includes("GC")), seen);
}

main().then(() => report("deep history aliases"));

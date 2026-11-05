import { check, report, stubFetch } from "./_harness";
import { __resetCacheForTests } from "@/lib/data-sources/cache";
import { __resetQuotaForTests } from "@/lib/data-sources/quota";
import { fetchSp500Valuation, parseFinvizPe, parseMultplCurrent, parseMultplTable } from "@/lib/data-sources/valuation";
import { analyzeValuation, inEarningsSeason, pePercentile } from "@/lib/analysis/valuation";
import type { CommodityMeta } from "@/types/signal";

/** 估值 — three keyless sources in order, and the two slow votes they feed. */

const multplHtml = `<div id="current">Current S&P 500 PE Ratio: <b>28.12</b> <span>Nov 4, 2026</span></div>`;
const tableHtml = Array.from({ length: 60 }, (_, i) => {
  const d = new Date(Date.UTC(2026 - Math.floor(i / 12), 10 - (i % 12) < 0 ? 12 + (10 - (i % 12)) : 10 - (i % 12), 1));
  const pe = 18 + (i % 10);
  return `<tr><td class="left">${d.toLocaleString("en-US", { month: "short" })} 1, ${d.getUTCFullYear()}</td><td class="right">${pe}.00</td></tr>`;
}).join("");
const finvizHtml = `<td class="snapshot-td2-cp">P/E</td><td class="snapshot-td2"><b>26.40</b></td>`;

check("multpl current parses", parseMultplCurrent(multplHtml) === 28.12, parseMultplCurrent(multplHtml));
check("multpl rejects nonsense", parseMultplCurrent("PE Ratio: 999.9") === null);
check("multpl table parses rows oldest first", (() => { const t = parseMultplTable(tableHtml); return t.length === 60 && t[0].date < t[59].date; })(), parseMultplTable(tableHtml).slice(0, 2));
check("finviz parses the ETF P/E", parseFinvizPe(finvizHtml) === 26.4);

const index = { symbol: "SPX500", label: "S&P 500", category: "index" } as CommodityMeta;
const dax = { symbol: "GER40", label: "DAX", category: "index" } as CommodityMeta;
const gold = { symbol: "XAUUSD", label: "黃金", category: "metal" } as CommodityMeta;

{
  const history = Array.from({ length: 120 }, (_, i) => ({ date: `2017-${String((i % 12) + 1).padStart(2, "0")}-01`, pe: 15 + (i % 20) }));
  check("percentile counts prints below today's", pePercentile(34, history) === 95, pePercentile(34, history));
  check("fewer than 36 prints gives no percentile", pePercentile(20, history.slice(0, 10)) === null);
}

{
  const v = { pe: 30, earningsYieldPct: 3.33, history: Array.from({ length: 120 }, (_, i) => ({ date: `d${i}`, pe: 15 + (i % 14) })), source: "multpl" as const, asOf: "2026-11-04T00:00:00Z" };
  const items = analyzeValuation(index, v, 4.3, new Date("2026-06-01T00:00:00Z"), true);
  const erp = items.find((i) => i.key === "valuation-erp");
  check("a thin ERP votes short", erp?.direction === "short" && erp.weight === 1, erp);
  check("and quotes the arithmetic", (erp?.factor.includes("3.33%") ?? false) && (erp?.factor.includes("4.3%") ?? false), erp?.factor);
  const pct = items.find((i) => i.key === "valuation-percentile");
  check("a top-decile multiple votes short", pct?.direction === "short" && pct.weight === 1, pct);
  check("outside earnings season nothing is added", !items.some((i) => i.key === "earnings-season"));

  const cheap = analyzeValuation(index, { ...v, pe: 14, earningsYieldPct: 7.14 }, 3.5, new Date("2026-06-01T00:00:00Z"), true);
  check("a rich ERP votes long", cheap.find((i) => i.key === "valuation-erp")?.direction === "long");
  const mid = analyzeValuation(index, { ...v, pe: 22, earningsYieldPct: 4.55 }, 2.5, new Date("2026-06-01T00:00:00Z"), true);
  check("the middle votes nothing", mid.every((i) => i.weight === 0), mid.map((i) => [i.key, i.weight]));
  const proxy = analyzeValuation(dax, v, 4.3, new Date("2026-06-01T00:00:00Z"), true);
  check("GER40 gets the US multiple as a weight-0 proxy", proxy.length > 0 && proxy.every((i) => i.weight === 0 && i.factor.includes("代理")), proxy.map((i) => i.weight));
  check("non-index symbols get nothing", analyzeValuation(gold, v, 4.3).length === 0);
  check("no history means no percentile vote", analyzeValuation(index, { ...v, history: [] }, 4.3, new Date("2026-06-01T00:00:00Z"), true).find((i) => i.key === "valuation-percentile")?.weight === 0);
}

{
  check("late October is earnings season", inEarningsSeason(new Date("2026-10-28T00:00:00Z")).active);
  check("early November still is", inEarningsSeason(new Date("2026-11-04T00:00:00Z")).active);
  check("early June is not", !inEarningsSeason(new Date("2026-06-03T00:00:00Z")).active);
  const noKey = analyzeValuation(index, null, null, new Date("2026-10-28T00:00:00Z"), false);
  check("without a Finnhub calendar the clock supplies 財報季 at weight 0", noKey.some((i) => i.key === "earnings-season" && i.weight === 0), noKey);
}

async function main() {
  // Ladder: multpl down → Nasdaq Data Link answers.
  __resetCacheForTests();
  __resetQuotaForTests();
  stubFetch((url) => {
    if (url.includes("multpl.com")) return { status: 503, body: "down" };
    if (url.includes("data.nasdaq.com")) return { status: 200, json: { dataset: { data: [["2026-11-01", 27.5], ["2026-10-01", 27.1]] } } };
    return { status: 404, body: "" };
  });
  const gaps: string[] = [];
  const v = await fetchSp500Valuation(gaps);
  check("the second rung answers when the first is down", v?.source === "nasdaq-data-link" && v.pe === 27.5, v);
  check("history comes oldest first", v?.history[0].date === "2026-10-01");
  check("a working ladder reports no gap", gaps.length === 0, gaps);

  // All three down → null + one gap naming the ladder.
  __resetCacheForTests();
  __resetQuotaForTests();
  stubFetch(() => ({ status: 503, body: "down" }));
  const gaps2: string[] = [];
  const none = await fetchSp500Valuation(gaps2);
  check("all rungs down means null, never a made-up multiple", none === null);
  check("and the gap names the family", gaps2.some((g) => g.includes("估值")), gaps2);

  // Finviz as the last rung.
  __resetCacheForTests();
  __resetQuotaForTests();
  stubFetch((url) => (url.includes("finviz") ? { status: 200, body: finvizHtml } : { status: 500, body: "" }));
  const fv = await fetchSp500Valuation([]);
  check("the third rung is reached", fv?.source === "finviz" && fv.pe === 26.4, fv);
  report("valuation");
}
void main();

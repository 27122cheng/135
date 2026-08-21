import { COMMODITIES } from "@/types/signal";
import { fetchDeepD1, fetchDeepH4 } from "@/lib/data-sources/deep-history";
import { runLab, VERIFY_FLOOR } from "@/lib/analysis/lab";
import { json } from "@/lib/json-response";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 實驗室 — measures entry conditions instead of arguing about them.
 *
 * One symbol, one direction per request: the pairwise sweep is O(n²) over
 * candles and running nine symbols in one call would blow the function
 * ceiling. The candles come from the same cached OHLCV every other analyzer
 * uses, so a lab run costs no extra upstream request inside the TTL.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol")?.toUpperCase() ?? "XAUUSD";
  const direction = url.searchParams.get("direction") === "short" ? "short" : "long";
  const timeframe = url.searchParams.get("timeframe") === "H4" ? "H4" : "D1";
  const meta = COMMODITIES.find((c) => c.symbol === symbol);
  if (!meta) return json({ error: `Unknown symbol ${symbol}` }, { status: 404 });

  const gaps: string[] = [];
  try {
    // Deep history, and as much of it as the free sources hold. The analysis
    // fetches one year of D1 / three months of H4, which cannot carry this
    // measurement — see lib/data-sources/deep-history.ts. H4's two-year cap
    // still resamples to a sample on par with a decade of daily bars, and it
    // accumulates six times faster.
    const deep = timeframe === "H4" ? await fetchDeepH4(meta, gaps) : await fetchDeepD1(meta, gaps);
    if (!deep?.candles?.length) {
      return json({ error: "取不到 K 棒，無法進行實驗", gaps }, { status: 502 });
    }
    const report = runLab(meta, deep.candles, direction, VERIFY_FLOOR, timeframe);
    if (!report) {
      return json(
        {
          error: `K 棒不足（${deep.candles.length} 根）。實驗需要足夠的歷史才能切出樣本內／樣本外兩半。`,
          gaps,
        },
        { status: 422 },
      );
    }
    const sourceName =
      deep.source === "stooq"
        ? "Stooq 完整日線"
        : deep.source === "twelvedata"
          ? `Twelve Data ${timeframe === "H4" ? "原生 4h K 線" : "日線"}（最多 5000 根）`
          : timeframe === "H4"
            ? "行情代理 1 小時線重組為 4 小時（免費上限兩年）"
            : "行情代理 10 年日線";
    report.notes.unshift(
      `歷史來源：${sourceName}，` +
        `共 ${deep.candles.length} 根、約 ${deep.years} 年（${deep.candles[0].time.slice(0, 10)} 起）。` +
        (timeframe === "D1"
          ? `分析頁只取 1 年日線，實驗室刻意另外取深度歷史 —— 一年的資料連 100 筆樣本的門檻都放不下。`
          : ""),
    );
    return json({ report, gaps });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err), gaps }, { status: 502 });
  }
}

import { COMMODITIES } from "@/types/signal";
import { fetchDeepD1 } from "@/lib/data-sources/deep-history";
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
  const meta = COMMODITIES.find((c) => c.symbol === symbol);
  if (!meta) return json({ error: `Unknown symbol ${symbol}` }, { status: 404 });

  const gaps: string[] = [];
  try {
    // D1, and as many years of it as the free sources hold.
    //
    // The analysis fetches one year, which cannot carry this measurement: 250
    // bars leave at most 95 candidate in-sample entries against a 100-trade
    // floor, so every combination failed on arithmetic rather than on evidence.
    // See lib/data-sources/deep-history.ts.
    const deep = await fetchDeepD1(meta, gaps);
    if (!deep?.candles?.length) {
      return json({ error: "取不到 K 棒，無法進行實驗", gaps }, { status: 502 });
    }
    const report = runLab(meta, deep.candles, direction, VERIFY_FLOOR);
    if (!report) {
      return json(
        {
          error: `K 棒不足（${deep.candles.length} 根）。實驗需要足夠的歷史才能切出樣本內／樣本外兩半。`,
          gaps,
        },
        { status: 422 },
      );
    }
    report.notes.unshift(
      `歷史來源：${deep.source === "stooq" ? "Stooq 完整日線" : "行情代理 10 年日線"}，` +
        `共 ${deep.candles.length} 根、約 ${deep.years} 年（${deep.candles[0].time.slice(0, 10)} 起）。` +
        `分析頁只取 1 年日線，實驗室刻意另外取深度歷史 —— 一年的資料連 100 筆樣本的門檻都放不下。`,
    );
    return json({ report, gaps });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err), gaps }, { status: 502 });
  }
}

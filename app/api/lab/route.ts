import { COMMODITIES } from "@/types/signal";
import { fetchOHLCV } from "@/lib/data-sources/ohlcv";
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
    // D1 — the timeframe the entry rules are written against. H4 would give
    // more samples and a different question; the lab must measure the rules
    // the system actually runs.
    const d1 = await fetchOHLCV(meta, "D1", gaps);
    if (!d1?.candles?.length) {
      return json({ error: "取不到 K 棒，無法進行實驗", gaps }, { status: 502 });
    }
    const report = runLab(meta, d1.candles, direction, VERIFY_FLOOR);
    if (!report) {
      return json(
        {
          error: `K 棒不足（${d1.candles.length} 根）。實驗需要足夠的歷史才能切出樣本內／樣本外兩半。`,
          gaps,
        },
        { status: 422 },
      );
    }
    return json({ report, gaps });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err), gaps }, { status: 502 });
  }
}

import { fetchViaProxy, OHLCV_TTL_MS } from "@/lib/data-sources/yfinance";
import type { Timeframe } from "@/types/signal";
import { json } from "@/lib/json-response";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * The HTTP surface of the self-hosted market-data proxy.
 *
 * The analysis pipeline calls lib/data-sources/yfinance.ts directly — a
 * serverless function making an HTTP request to itself would double the
 * invocations for nothing. This route exists so the browser (and anything else
 * outside the server) can reach the same cached, quota-tracked data without
 * needing a key or hitting CORS.
 */

// The ticker is interpolated into an upstream URL, so the character set is
// restricted to what real Yahoo tickers use rather than sanitised after the fact.
const TICKER_PATTERN = /^[A-Za-z0-9=^._-]{1,24}$/;
const TIMEFRAMES: Timeframe[] = ["H4", "D1", "W1"];

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const ticker = (params.get("ticker") ?? "").trim();
  const timeframe = (params.get("timeframe") ?? "D1").trim().toUpperCase() as Timeframe;

  if (!TICKER_PATTERN.test(ticker)) {
    return json({ error: "ticker 格式不正確" }, { status: 400 });
  }
  if (!TIMEFRAMES.includes(timeframe)) {
    return json(
      { error: `timeframe 必須是 ${TIMEFRAMES.join(" / ")}（本專案不做日內）` },
      { status: 400 },
    );
  }

  const gaps: string[] = [];
  const result = await fetchViaProxy(ticker, timeframe, gaps);
  if (!result) {
    return json(
      { error: `無法取得 ${ticker} ${timeframe} 的 K 線`, notes: gaps },
      { status: 502 },
    );
  }

  return json(
    {
      ticker: result.ticker,
      timeframe: result.timeframe,
      // Delayed by the upstream free tier — stated in the payload so a consumer
      // can't mistake it for a live quote.
      delayed: true,
      stale: result.stale,
      age_ms: result.ageMs,
      count: result.candles.length,
      candles: result.candles,
      notes: gaps,
    },
    {
      headers: {
        "cache-control": `public, max-age=${Math.floor(OHLCV_TTL_MS / 1000)}, stale-while-revalidate=3600`,
      },
    },
  );
}

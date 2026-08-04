import { NextResponse } from "next/server";
import { fetchYieldSeries, YIELD_TTL_MS } from "@/lib/data-sources/yields";
import { rateSpreadFor, RATE_SPREADS } from "@/config/rate-spreads";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * HTTP surface over the yield fetcher, mirroring /api/proxy/ohlcv.
 *
 * The analysis calls lib/data-sources/yields.ts directly — a serverless
 * function requesting its own endpoint would double the invocations for
 * nothing. This exists so the data is inspectable without a key, and so a
 * wrong Stooq ticker can be diagnosed by asking for it directly.
 *
 * Legs are addressed by symbol rather than by raw ticker: the codes live in
 * config/rate-spreads.ts, and letting a caller pass an arbitrary ticker would
 * put an unvalidated string into an upstream URL for no benefit.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const symbol = (params.get("symbol") ?? "").trim().toUpperCase();
  const config = rateSpreadFor(symbol);

  if (!config) {
    return NextResponse.json(
      {
        error: `${symbol || "(未指定)"} 沒有對應的利差設定`,
        available: Object.keys(RATE_SPREADS),
      },
      { status: 404 },
    );
  }

  const gaps: string[] = [];
  const [minuend, subtrahend] = await Promise.all([
    fetchYieldSeries(config.minuend, gaps),
    fetchYieldSeries(config.subtrahend, gaps),
  ]);

  if (!minuend || !subtrahend) {
    return NextResponse.json(
      { error: `無法取得 ${config.label} 的兩隻腳`, notes: gaps },
      { status: 502 },
    );
  }

  return NextResponse.json(
    {
      symbol,
      label: config.label,
      tenor: config.tenor,
      // Both legs are end-of-day; stated so a consumer can't mistake this for
      // an intraday quote.
      delayed: true,
      legs: {
        minuend: { label: minuend.label, source: minuend.source, points: minuend.points.slice(-60) },
        subtrahend: {
          label: subtrahend.label,
          source: subtrahend.source,
          points: subtrahend.points.slice(-60),
        },
      },
      notes: gaps,
    },
    {
      headers: {
        "cache-control": `public, max-age=${Math.floor(YIELD_TTL_MS / 1000)}, stale-while-revalidate=86400`,
      },
    },
  );
}

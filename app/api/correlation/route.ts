import { COMMODITIES } from "@/types/signal";
import { allInstruments } from "@/lib/server-symbols";
import { fetchOHLCV, type Candle } from "@/lib/data-sources/ohlcv";
import { correlationReport } from "@/lib/analysis/correlation";
import { json } from "@/lib/json-response";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 相關性檢查 for the ranking page.
 *
 * Reads the same cached D1 series every analyzer uses — inside the OHLCV TTL
 * this costs no upstream request at all, and after a scan the cache is always
 * warm. Symbols whose candles cannot be fetched are simply absent from the
 * matrix (and named in `gaps`) rather than failing the whole report: a
 * correlation check with seven instruments is still a correlation check.
 */
export async function GET() {
  const gaps: string[] = [];
  // The roster: a BTC/ETH position correlates with the book like any other,
  // and the sizing halving that reads this report could not see them.
  const roster = await allInstruments().catch(() => [...COMMODITIES]);
  const entries = await Promise.all(
    roster.map(async (meta) => {
      const d1 = await fetchOHLCV(meta, "D1", gaps).catch(() => null);
      return [meta.symbol, d1?.candles] as [string, Candle[] | undefined];
    }),
  );
  const report = correlationReport(Object.fromEntries(entries));
  if (report.symbols.length < 2) {
    return json(
      { error: "取得的 K 棒不足以計算任何一組相關性", gaps: [...new Set(gaps)] },
      { status: 502 },
    );
  }
  return json({ report, gaps: [...new Set(gaps)] });
}

import { NextResponse } from "next/server";
import { COMMODITIES } from "@/types/signal";
import { buildTradeSignal } from "@/lib/signal-builder";

export const dynamic = "force-dynamic";
// The pipeline makes several external calls; Vercel's default 10s is not enough.
// 60s is the Hobby-plan ceiling — raise it only if your plan allows more.
export const maxDuration = 60;

export async function GET(_request: Request, { params }: { params: { symbol: string } }) {
  const symbol = params.symbol.toUpperCase();
  const meta = COMMODITIES.find((c) => c.symbol === symbol);
  if (!meta) {
    return NextResponse.json({ error: `Unknown symbol ${params.symbol}` }, { status: 404 });
  }
  try {
    const signal = await buildTradeSignal(meta.symbol);
    return NextResponse.json(signal);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : `Unknown error building ${meta.symbol} signal` },
      { status: 502 },
    );
  }
}

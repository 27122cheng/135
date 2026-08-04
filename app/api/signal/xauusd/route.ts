import { NextResponse } from "next/server";
import { buildTradeSignal } from "@/lib/signal-builder";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const signal = await buildTradeSignal("XAUUSD");
    return NextResponse.json(signal);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error building XAUUSD signal" },
      { status: 502 },
    );
  }
}

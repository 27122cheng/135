import { getSignalStore } from "@/lib/db";
import { runIntradaySweep } from "@/lib/intraday/sweep";
import { json } from "@/lib/json-response";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 日內模式（加密貨幣）— signals now, paper ledger advanced when a store exists. */
export async function GET() {
  try {
    return json(await runIntradaySweep(getSignalStore()));
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "日內掃描失敗" }, { status: 502 });
  }
}

import { NextResponse } from "next/server";
import { COMMODITIES } from "@/types/signal";
import { buildTradeSignal } from "@/lib/signal-builder";
import { getSupabaseServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
// 60s is the Hobby-plan ceiling; a higher value fails deployment there.
// Building 9 symbols may still exceed it — raise this if your plan allows.
export const maxDuration = 60;

/**
 * Vercel Cron target (see vercel.json, every 4h). Builds a fresh signal for
 * all 9 symbols in parallel and inserts each as a new row into `signals`
 * (append-only, so /history can show the timeline) — one symbol's failure
 * doesn't block the others.
 */
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json(
      {
        error:
          "Supabase 未設定（缺少 NEXT_PUBLIC_SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY），無法寫入 signals",
      },
      { status: 501 },
    );
  }

  const settled = await Promise.allSettled(
    COMMODITIES.map(async (meta) => {
      const signal = await buildTradeSignal(meta.symbol);
      const { error } = await supabase.from("signals").insert({
        symbol: signal.symbol,
        direction: signal.direction,
        grade: signal.grade,
        bias_score: signal.bias_score,
        entry_structure_score: signal.entry_structure_score,
        total_score: signal.total_score,
        entry_zone: signal.entry_zone,
        stop_loss: signal.stop_loss,
        take_profits: signal.take_profits,
        bias_items: signal.bias_items,
        entry_structures: signal.entry_structures,
        path_obstacles: signal.path_obstacles,
        narrative: signal.narrative,
        data_gaps: signal.data_gaps,
        generated_at: signal.generated_at,
      });
      if (error) throw new Error(error.message);
      return { symbol: meta.symbol, grade: signal.grade };
    }),
  );

  const results = settled.map((s, i) =>
    s.status === "fulfilled"
      ? { symbol: COMMODITIES[i].symbol, status: "ok" as const, grade: s.value.grade }
      : {
          symbol: COMMODITIES[i].symbol,
          status: "error" as const,
          detail: s.reason instanceof Error ? s.reason.message : String(s.reason),
        },
  );

  return NextResponse.json({ ranAt: new Date().toISOString(), results });
}

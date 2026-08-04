import { NextResponse } from "next/server";
import { getSupabaseAnonClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/** Filterable history read for the /history page: ?symbol=&grade=&from=&to=&limit= */
export async function GET(request: Request) {
  const supabase = getSupabaseAnonClient();
  if (!supabase) {
    return NextResponse.json(
      {
        error:
          "Supabase 未設定（缺少 NEXT_PUBLIC_SUPABASE_URL 或 NEXT_PUBLIC_SUPABASE_ANON_KEY），歷史訊號功能無法使用",
        rows: [],
      },
      { status: 501 },
    );
  }

  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get("symbol");
  const grade = searchParams.get("grade");
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const limit = Math.min(Number(searchParams.get("limit") ?? "50") || 50, 200);

  let query = supabase
    .from("signals")
    .select("*")
    .order("generated_at", { ascending: false })
    .limit(limit);
  if (symbol) query = query.eq("symbol", symbol);
  if (grade) query = query.eq("grade", grade);
  if (from) query = query.gte("generated_at", from);
  if (to) query = query.lte("generated_at", to);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message, rows: [] }, { status: 502 });
  }
  return NextResponse.json({ rows: data ?? [] });
}

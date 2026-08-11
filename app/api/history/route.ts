import { getSignalStore } from "@/lib/db";
import { json } from "@/lib/json-response";

export const dynamic = "force-dynamic";

/** Filterable history read for the /history page: ?symbol=&grade=&from=&to=&limit= */
export async function GET(request: Request) {
  const store = getSignalStore();
  if (!store) {
    return json(
      {
        error:
          "未設定資料庫（DATABASE_URL，或 NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY），歷史訊號功能無法使用",
        rows: [],
      },
      { status: 501 },
    );
  }

  const { searchParams } = new URL(request.url);
  try {
    const rows = await store.listSignals({
      symbol: searchParams.get("symbol"),
      grade: searchParams.get("grade"),
      from: searchParams.get("from"),
      to: searchParams.get("to"),
      stance: searchParams.get("stance") === "enter" ? "enter" : null,
      // Capped so a crafted ?limit= can't ask the database for everything.
      limit: Math.min(Number(searchParams.get("limit") ?? "50") || 50, 200),
    });
    return json({ rows });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : "讀取歷史訊號失敗", rows: [] },
      { status: 502 },
    );
  }
}

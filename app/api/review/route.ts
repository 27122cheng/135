import { getSignalStore } from "@/lib/db";
import { computeReviewStats } from "@/lib/journal/stats";
import { summariseTags, triggeredTags } from "@/lib/journal/interventions";
import { json } from "@/lib/json-response";

export const dynamic = "force-dynamic";

/**
 * Stats behind /review. Computed server-side from journal rows so the page
 * ships numbers, not a copy of the formulas.
 */
export async function GET(request: Request) {
  const store = getSignalStore();
  if (!store) {
    return json(
      { error: "未設定資料庫（DATABASE_URL 或 Supabase），交易日誌與復盤無法使用" },
      { status: 501 },
    );
  }

  const symbol = new URL(request.url).searchParams.get("symbol");
  try {
    const entries = await store.listJournal({ symbol, limit: 500 });
    const stats = computeReviewStats(entries);
    // Which tags are currently tightening new signals, so the page can show
    // the live consequence of the history above it.
    const tagStats = summariseTags(entries);
    return json({
      ...stats,
      activeInterventions: triggeredTags(tagStats),
      recentTagStats: tagStats,
    });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : "讀取復盤統計失敗" },
      { status: 502 },
    );
  }
}

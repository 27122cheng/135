import { getSignalStore, type LabTradeRow } from "@/lib/db";
import { censusOf } from "@/lib/analysis/blockers";
import { summariseForward } from "@/lib/analysis/lab-forward";
import { buildRiskAdvice } from "@/lib/journal/advice";
import { computeReviewStats, computeTrackRecord } from "@/lib/journal/stats";
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

    // 卡在哪一關 — the census over the last week of scans, not a snapshot.
    //
    // Answers the question the journal cannot while it is empty: with almost
    // nothing ever entering, "勝率" has no denominator and the page reads as
    // broken. The distribution of *rejections* is real data from the first
    // scan onward, and it is what says which threshold is worth arguing about.
    //
    // A week of history, deliberately. This used to read latestPerSymbol —
    // nine rows, the current moment — which answers "what is blocking right
    // now" and cannot answer the question actually being asked: "交易過少，
    // 是條件太嚴格還是什麼原因". Nine rows is an anecdote; ~380 scans is the
    // distribution the classifier was built to produce.
    const CENSUS_WINDOW_DAYS = 7;
    const since = new Date(Date.now() - CENSUS_WINDOW_DAYS * 86_400_000).toISOString();
    const week = await store
      .listSignals({ symbol, from: since, limit: 600 })
      .catch(() => []);
    // Fall back to the snapshot when the timeline is empty (fresh database).
    const scoped =
      week.length > 0
        ? week
        : (await store.latestPerSymbol().catch(() => [])).filter(
            (s) => !symbol || s.symbol === symbol,
          );
    const census = censusOf(scoped);
    const censusWindowDays = week.length > 0 ? CENSUS_WINDOW_DAYS : 0;
    // Forward-test results: real resolved trades, per condition, accumulating
    // whether or not any signal ever cleared the gates.
    const labTrades = await store
      .listLabTrades({ symbol, limit: 4000 })
      .catch(() => [] as LabTradeRow[]);
    const labStats = summariseForward(labTrades);
    const labResolved = labStats.reduce((n, s) => n + s.resolved, 0);
    const labWins = labStats.reduce((n, s) => n + s.wins, 0);
    // Which tags are currently tightening new signals, so the page can show
    // the live consequence of the history above it.
    const tagStats = summariseTags(entries);
    const active = triggeredTags(tagStats);
    return json({
      ...stats,
      trackRecord: computeTrackRecord(entries),
      activeInterventions: active,
      recentTagStats: tagStats,
      riskAdvice: buildRiskAdvice(tagStats, active),
      blockers: { census, scanned: scoped.length, windowDays: censusWindowDays },
      forward: {
        conditions: labStats.slice(0, 8),
        resolved: labResolved,
        wins: labWins,
        hitRate: labResolved > 0 ? Math.round((labWins / labResolved) * 1000) / 1000 : null,
        open: labTrades.filter((t) => t.status === "open").length,
      },
    });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : "讀取復盤統計失敗" },
      { status: 502 },
    );
  }
}

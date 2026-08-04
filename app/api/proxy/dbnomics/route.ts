import { NextResponse } from "next/server";
import { fetchDbnomicsSeries, searchDbnomics } from "@/lib/data-sources/dbnomics";
import { DBNOMICS_GOLD_SOURCES, SCRAPER_ONLY_SOURCES } from "@/config/gold-fundamentals";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// A DBnomics id is provider/dataset/series. Restricted rather than sanitised,
// since it goes straight into an upstream path.
const SERIES_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.@-]+$/;

/**
 * Discovery and verification for the DBnomics series ids.
 *
 * The ids in config/gold-fundamentals.ts were written from documented dataset
 * naming and could not be checked against a live response from the build
 * sandbox. This route exists so a wrong one can be found and fixed instead of
 * quietly disabling a factor forever:
 *
 *   GET /api/proxy/dbnomics                      → config vs. what resolves
 *   GET /api/proxy/dbnomics?search=china gold    → candidate series ids
 *   GET /api/proxy/dbnomics?series=IMF/IFS/...   → one series' observations
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const gaps: string[] = [];

  const search = params.get("search")?.trim();
  if (search) {
    const hits = await searchDbnomics(search, gaps);
    return NextResponse.json({ query: search, hits: hits ?? [], notes: gaps });
  }

  const series = params.get("series")?.trim();
  if (series) {
    if (!SERIES_PATTERN.test(series)) {
      return NextResponse.json(
        { error: "series 必須是 provider/dataset/series 格式" },
        { status: 400 },
      );
    }
    const result = await fetchDbnomicsSeries(series, gaps);
    if (!result) {
      return NextResponse.json({ error: `查無序列 ${series}`, notes: gaps }, { status: 404 });
    }
    return NextResponse.json({
      seriesId: result.seriesId,
      name: result.name,
      count: result.points.length,
      latest: result.points.at(-1),
      points: result.points.slice(-24),
      notes: gaps,
    });
  }

  // Default: check every configured id at once, so a broken config is one
  // request away from being visible.
  const checked = await Promise.all(
    DBNOMICS_GOLD_SOURCES.map(async (source) => {
      const local: string[] = [];
      const result = await fetchDbnomicsSeries(source.series, local);
      return {
        id: source.id,
        label: source.label,
        frequency: source.frequency,
        series: source.series,
        resolved: result !== null,
        latestPeriod: result?.points.at(-1)?.period ?? null,
        observations: result?.points.length ?? 0,
      };
    }),
  );

  const unresolved = checked.filter((c) => !c.resolved);
  return NextResponse.json({
    configured: checked,
    unresolvedCount: unresolved.length,
    hint:
      unresolved.length > 0
        ? `${unresolved.length} 個序列代碼查不到。用 ?search=關鍵字 找出正確代碼，再更新 config/gold-fundamentals.ts`
        : "全部序列代碼都能解析",
    // Listed so it's clear these are absent by design, not forgotten.
    notCoveredByDbnomics: SCRAPER_ONLY_SOURCES,
  });
}

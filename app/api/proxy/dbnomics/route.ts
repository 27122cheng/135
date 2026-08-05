import { NextResponse } from "next/server";
import {
  fetchDbnomicsSeries,
  inferFrequency,
  periodEndDate,
  searchDbnomics,
} from "@/lib/data-sources/dbnomics";
import {
  DBNOMICS_GOLD_SOURCES,
  SCRAPER_ONLY_SOURCES,
  maxAgeDays,
} from "@/config/gold-fundamentals";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// A DBnomics id is provider/dataset/series. Restricted rather than sanitised,
// since it goes straight into an upstream path.
const SERIES_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.@-]+$/;

/**
 * Discovery and verification for the DBnomics series ids.
 *
 * The ids in config/gold-fundamentals.ts were written from documented dataset
 * naming and cannot be checked against a live response from the build sandbox.
 * Worse, resolving is not proof of correctness: IMF/IFS answered every request
 * while its latest observation sat 400 days in the past, which disabled all
 * five gold factors while looking, from the code's side, like a working source.
 *
 * So this route reports freshness, not just existence, and says outright which
 * candidate each source would pick:
 *
 *   GET /api/proxy/dbnomics                      → every candidate, with 過期 verdicts
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
      observedFrequency: inferFrequency(result.points),
      latest: result.points.at(-1),
      points: result.points.slice(-24),
      notes: gaps,
    });
  }

  const now = Date.now();

  // Default: check every candidate of every configured source at once, so a
  // dead dataset is one request away from being visible.
  const checked = await Promise.all(
    DBNOMICS_GOLD_SOURCES.map(async (source) => {
      const candidates = await Promise.all(
        source.series.map(async (seriesId) => {
          const local: string[] = [];
          const result = await fetchDbnomicsSeries(seriesId, local);
          if (!result) {
            return { seriesId, resolved: false, fresh: false, notes: local };
          }

          const latest = result.points.at(-1) ?? null;
          const observed = inferFrequency(result.points);
          const end = latest ? periodEndDate(latest.period) : null;
          const ageDays = end ? Math.floor((now - end.getTime()) / 86_400_000) : null;
          const limit = maxAgeDays(source, observed ?? undefined);
          return {
            seriesId,
            resolved: true,
            latestPeriod: latest?.period ?? null,
            observations: result.points.length,
            observedFrequency: observed,
            ageDays,
            limitDays: limit,
            fresh: ageDays !== null && ageDays <= limit,
            notes: local,
          };
        }),
      );

      const winner = candidates.find((c) => c.resolved && c.fresh);
      return {
        id: source.id,
        label: source.label,
        declaredFrequency: source.frequency,
        usable: winner !== undefined,
        usingSeries: winner?.seriesId ?? null,
        candidates,
      };
    }),
  );

  const broken = checked.filter((c) => !c.usable);
  return NextResponse.json({
    configured: checked,
    usableCount: checked.length - broken.length,
    brokenCount: broken.length,
    hint:
      broken.length > 0
        ? `${broken.length} 個來源沒有任何候選序列是即時的。看 candidates 裡的 latestPeriod：` +
          `resolved=false 代表代碼錯，fresh=false 代表該資料集已停更。` +
          `用 ?search=關鍵字 找出替代代碼，再更新 config/gold-fundamentals.ts`
        : "每個來源都有即時的候選序列",
    // Listed so it's clear these are absent by design, not forgotten.
    notCoveredByDbnomics: SCRAPER_ONLY_SOURCES,
  });
}

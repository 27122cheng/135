import { NextResponse } from "next/server";
import { COMMODITIES } from "@/types/signal";
import { buildTradeSignal } from "@/lib/signal-builder";
import { getSignalStore } from "@/lib/db";

export const dynamic = "force-dynamic";
// Vercel Hobby's ceiling. One symbol comfortably fits; all nine may not, which
// is why the workflow calls this once per symbol instead of once per run.
export const maxDuration = 60;

/**
 * Refresh target, driven by GitHub Actions (.github/workflows/refresh.yml).
 *
 * Not Vercel Cron: the Hobby plan only allows one cron run per day, and the
 * spec calls for every 4 hours. GitHub Actions has no such limit on a public
 * repo, so the schedule lives there and this route is just an authenticated
 * endpoint it can call.
 *
 * `?symbol=` builds one symbol; omitting it builds all nine, which is likely
 * to exceed 60s on Hobby — the workflow loops instead.
 */
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const store = getSignalStore();
  if (!store) {
    return NextResponse.json(
      {
        error:
          "未設定資料庫（DATABASE_URL 或 NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY），無法寫入 signals",
      },
      { status: 501 },
    );
  }

  const requested = new URL(request.url).searchParams.get("symbol")?.toUpperCase();
  const targets = requested
    ? COMMODITIES.filter((c) => c.symbol === requested)
    : COMMODITIES;
  if (targets.length === 0) {
    return NextResponse.json({ error: `Unknown symbol ${requested}` }, { status: 404 });
  }

  // allSettled: one symbol failing must not cost the others their refresh.
  const settled = await Promise.allSettled(
    targets.map(async (meta) => {
      const signal = await buildTradeSignal(meta.symbol);
      await store.insertSignal(signal);
      return { grade: signal.grade, gaps: signal.data_gaps.length };
    }),
  );

  const results = settled.map((s, i) =>
    s.status === "fulfilled"
      ? { symbol: targets[i].symbol, status: "ok" as const, ...s.value }
      : {
          symbol: targets[i].symbol,
          status: "error" as const,
          detail: s.reason instanceof Error ? s.reason.message : String(s.reason),
        },
  );
  const failed = results.filter((r) => r.status === "error").length;

  return NextResponse.json(
    { ranAt: new Date().toISOString(), store: store.kind, results },
    // A non-2xx makes the workflow step fail loudly instead of a green run
    // that quietly wrote nothing.
    { status: failed === targets.length ? 502 : 200 },
  );
}

import { COMMODITIES } from "@/types/signal";
import { groupDataGaps } from "@/lib/data-gaps";
import { describeStore, getSignalStore } from "@/lib/db";
import { notifyAll } from "@/lib/notify";
import type { IngestedRelease } from "@/lib/analysis/data-release";
import { runScan, storeScan } from "@/lib/scan";
import { advanceLedger } from "@/lib/lab-forward-runner";
import { configuredMinGrade, formatAlert, shouldAlert } from "@/lib/notify/alert";
import { json } from "@/lib/json-response";

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
      return json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const store = getSignalStore();
  if (!store) {
    return json(
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
    return json({ error: `Unknown symbol ${requested}` }, { status: 404 });
  }

  const minGrade = await configuredMinGrade();
  // Falls back to the origin this request arrived on, so the link in an alert
  // works without anyone setting APP_URL in Vercel as well as in GitHub.
  const appUrl = process.env.APP_URL?.trim() || new URL(request.url).origin;

  // Releases are ingested inside each scan (they are an input to it), and
  // collected here so the run still reports what landed.
  const releases: IngestedRelease[] = [];
  const releaseNotes: string[] = [];

  // allSettled: one symbol failing must not cost the others their refresh.
  const settled = await Promise.allSettled(
    targets.map(async (meta) => {
      // The previous row is read *before* inserting, so the comparison is
      // against the last run rather than against the signal we just wrote.
      const [previous] = await store
        .listSignals({ symbol: meta.symbol, limit: 1 })
        .catch(() => []);

      // The same scan the browser runs — same keys, same release ingestion,
      // same storage. Divergence here is what let Telegram announce a trade the
      // website did not have.
      const scan = await runScan(meta);
      const signal = scan.signal;
      releases.push(...scan.releases);
      releaseNotes.push(...scan.releaseNotes);
      const { storeError: latestError } = await storeScan(signal);

      // 前進實驗 — resolve what the new bars settled, open what this bar
      // triggers. Idempotent per bar (ids derive from the entry bar), so the
      // extra sweeps within a day cost two queries and write nothing. It must
      // never fail the refresh: the ledger is research, the signal is the job.
      const forward = await advanceLedger(meta, []).catch((err) => ({
        error: err instanceof Error ? err.message : String(err),
      }));

      // One trade at a time: while the monitor holds an unresolved position
      // on this symbol, new entries and level updates stay off the phone.
      const monitorState = await store.getMonitorState(meta.symbol).catch(() => null);
      const openTrade = monitorState?.state === "entered" || monitorState?.state === "added";
      const decision = shouldAlert(signal, previous ?? null, minGrade, { openTrade });
      let notified: string[] = [];
      if (decision.alert) {
        // A failing alert must not fail the refresh that produced it — the
        // signal is already stored and visible on the site either way.
        // The open-trade context rides along so a withdrawal over a filled
        // position reads as "the thesis weakened", never "your trade was
        // cancelled" — the monitor is still managing it.
        const results = await notifyAll(
          formatAlert(signal, decision.reason, appUrl, {
            openTrade,
            activeStop: monitorState?.activeStop ?? null,
          }),
        );
        notified = results.filter((r) => r.ok).map((r) => r.channel);
      }
      // The gap *lines*, not just a count. "gaps: 7" in a workflow log is
      // undiagnosable — the only way to check every symbol without a database
      // console is for the sweep to say exactly what each symbol is missing.
      const grouped = groupDataGaps(signal.data_gaps);
      return {
        grade: signal.grade,
        storeError: latestError,
        gaps: signal.data_gaps.length,
        actionable: grouped.keyRelated.length + grouped.other.length,
        gapLines: [...grouped.keyRelated, ...grouped.other],
        noteLines: [...grouped.informational, ...grouped.permanent],
        alerted: decision.alert,
        alertReason: decision.reason,
        notified,
        forward,
      };
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

  // Housekeeping on every call: a delete with nothing to delete costs
  // milliseconds, and the alternative — a full free-tier database refusing
  // writes — cost days to diagnose the last time storage misbehaved. Journal
  // rows are never touched; see the store's prune contract.
  const pruned = await store.prune?.().catch(() => null);

  return json(
    {
      ranAt: new Date().toISOString(),
      store: store.kind,
      // The host this sweep wrote to. Compared across runs (and against the
      // board's own `db` field) this catches a database that rotates per
      // deployment — the failure where every write "succeeds" and none survive.
      db: describeStore(),
      pruned: pruned && (pruned.signals > 0 || pruned.cache > 0) ? pruned : undefined,
      results,
      newReleases: [...new Set(releases.map((f) => `${f.release.label} ${f.period}`))],
      releaseNotes: [...new Set(releaseNotes)],
    },
    // A non-2xx makes the workflow step fail loudly instead of a green run
    // that quietly wrote nothing.
    { status: failed === targets.length ? 502 : 200 },
  );
}

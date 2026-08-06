import { COMMODITIES } from "@/types/signal";
import { parseUserKeyHeader } from "@/lib/api-keys";
import { runScan, storeScan } from "@/lib/scan";
import { json } from "@/lib/json-response";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Build one symbol **and store it**, for a scan the browser started.
 *
 * ## Why this exists rather than just calling /api/signal
 *
 * The board and the detail page were each building their own copy, and two
 * builds of the same symbol minutes apart returned different answers. The fix
 * is not to make the model deterministic, which isn't available; it is to stop
 * building the same signal twice. This route writes the result and every view
 * reads that one row, so agreement is structural.
 *
 * ## Why it is the same scan the scheduler runs
 *
 * Everything that decides *what the signal is* now lives in `lib/scan.ts` and
 * both routes call it — same key resolution, same release ingestion, same
 * storage. They used to differ in all three, which is how Telegram could
 * announce "US30 做多 ▲ A" while the site showed no-trade, and how the alert
 * could say "未設定任何 AI 金鑰" while the site reported a spent quota. Both
 * were true about themselves.
 *
 * ## Why it doesn't alert
 *
 * The one thing still allowed to differ. Sending Telegram is the scheduled
 * refresh's job: a button that pushed a notification to the owner's phone every
 * time they pressed it would train them to ignore the channel that exists to
 * interrupt them.
 *
 * ## Why it isn't behind CRON_SECRET
 *
 * `/api/signal` already does the identical work unauthenticated. The only thing
 * added here is a stored result, so gating it would cost the board its whole
 * reason for existing without protecting anything new.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol")?.toUpperCase();
  const meta = COMMODITIES.find((c) => c.symbol === symbol);
  if (!meta) {
    return json({ error: `Unknown symbol ${symbol ?? ""}` }, { status: 404 });
  }

  try {
    const scan = await runScan(meta, {
      extraKeys: parseUserKeyHeader(request.headers.get("x-user-keys")),
    });
    const { stored, storeError } = await storeScan(scan.signal);
    return json({
      signal: scan.signal,
      stored,
      // A failed write must not cost the caller the signal it just waited 20
      // seconds for — but it must not be silent either. Swallowing it is how
      // nine successful scans produced a board reading 已掃描 0/9 with no
      // explanation anywhere.
      storeError,
      releases: scan.releases.map((f) => `${f.release.label} ${f.period}`),
      // Which keys the *server* holds, as opposed to the ones this browser
      // sent. When the two differ, the scheduled run and this one are working
      // with different tools, and that is worth being able to see.
      serverKeys: scan.serverKeyNames,
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}

import { COMMODITIES } from "@/types/signal";
import { buildTradeSignal } from "@/lib/signal-builder";
import { getSignalStore } from "@/lib/db";
import { parseUserKeyHeader, withUserKeys } from "@/lib/api-keys";
import { storedApiKeys } from "@/lib/settings";
import { json } from "@/lib/json-response";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Build one symbol **and store it**, for a scan the browser started.
 *
 * ## Why this exists rather than just calling /api/signal
 *
 * The board and the detail page were each building their own copy. Two builds
 * of the same symbol minutes apart returned different answers — one said 觀望,
 * the other showed a full entry — because the trade plan's `stance` is chosen
 * by the AI, and an AI asked the same question twice does not have to answer
 * the same way. Nothing was stale and nothing was broken; the two views were
 * simply looking at two different signals.
 *
 * The fix is not to make the model deterministic, which isn't available. It is
 * to stop building the same signal twice: this route writes the result, and
 * every view reads that one row. Agreement becomes structural.
 *
 * ## Why it doesn't alert
 *
 * Sending Telegram is the scheduled refresh's job. A button in the UI that
 * pushed a notification to the owner's phone every time they pressed it would
 * train them to ignore the channel that exists to interrupt them.
 *
 * ## Why it isn't behind CRON_SECRET
 *
 * `/api/signal` already does the identical work unauthenticated. The only thing
 * added here is a row in the caller's own history, so gating it would cost the
 * board its whole reason for existing without protecting anything new.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol")?.toUpperCase();
  const meta = COMMODITIES.find((c) => c.symbol === symbol);
  if (!meta) {
    return json({ error: `Unknown symbol ${symbol ?? ""}` }, { status: 404 });
  }

  // Header first, stored second — a browser carrying its own keys must not have
  // them replaced by whatever the deployment happens to store.
  const merged = {
    ...(await storedApiKeys().catch(() => ({}))),
    ...parseUserKeyHeader(request.headers.get("x-user-keys")),
  };

  try {
    const signal = await withUserKeys(merged, () => buildTradeSignal(meta.symbol));

    const store = getSignalStore();
    let stored = false;
    if (store) {
      try {
        await store.insertSignal(signal);
        stored = true;
      } catch {
        // A failed write must not cost the caller the signal it just waited
        // 20 seconds for. It comes back unstored, and `stored: false` says so
        // rather than letting the board silently show an older row.
      }
    }
    return json({ signal, stored });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

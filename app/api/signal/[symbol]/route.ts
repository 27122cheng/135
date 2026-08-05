import { COMMODITIES } from "@/types/signal";
import { buildTradeSignal } from "@/lib/signal-builder";
import { parseUserKeyHeader, withUserKeys } from "@/lib/api-keys";
import { storedApiKeys } from "@/lib/settings";
import { json } from "@/lib/json-response";

export const dynamic = "force-dynamic";
// The pipeline makes several external calls; Vercel's default 10s is not enough.
// 60s is the Hobby-plan ceiling — raise it only if your plan allows more.
export const maxDuration = 60;

export async function GET(request: Request, { params }: { params: { symbol: string } }) {
  const symbol = params.symbol.toUpperCase();
  const meta = COMMODITIES.find((c) => c.symbol === symbol);
  if (!meta) {
    return json({ error: `Unknown symbol ${params.symbol}` }, { status: 404 });
  }
  // Keys the caller pasted into /settings, used for this request only and
  // never stored. Falls back to environment variables when absent.
  const userKeys = parseUserKeyHeader(request.headers.get("x-user-keys"));
  try {
    // Header first, stored second: a browser carrying its own keys must not
    // have them replaced by whatever the deployment happens to store.
    const merged = { ...(await storedApiKeys().catch(() => ({}))), ...userKeys };
    const signal = await withUserKeys(merged, () => buildTradeSignal(meta.symbol));
    return json(signal);
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : `Unknown error building ${meta.symbol} signal` },
      { status: 502 },
    );
  }
}

import { testAIProviders } from "@/lib/ai";
import { parseUserKeyHeader, withUserKeys } from "@/lib/api-keys";
import { storedApiKeys } from "@/lib/settings";
import { json } from "@/lib/json-response";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Live per-provider AI test behind the settings page's 測試 button.
 *
 * Uses the same key layering as a scan — stored keys first, the browser's
 * own keys over them — so the result describes what an actual analysis would
 * see, from either the browser or the schedule. Costs a few tokens per press;
 * no auth beyond that, because the caller is spending their own keys.
 */
export async function POST(request: Request) {
  const stored = await storedApiKeys().catch(() => ({}) as Record<string, string>);
  const keys = { ...stored, ...parseUserKeyHeader(request.headers.get("x-user-keys")) };
  try {
    const results = await withUserKeys(keys, () => testAIProviders());
    return json({ ranAt: new Date().toISOString(), results });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}

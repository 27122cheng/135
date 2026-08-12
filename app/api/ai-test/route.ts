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
  const merged = { ...stored, ...parseUserKeyHeader(request.headers.get("x-user-keys")) };
  try {
    // Two viewpoints, because "金鑰都設置了但顯示未設置" is exactly the
    // question of which side holds the key. The browser view is what a manual
    // rescan sees (stored + this device's keys); the schedule view is what
    // the hourly GitHub Actions sweep sees (stored only). A key that tests
    // 正常 in the first and 未設定 in the second was never saved server-side
    // — and that difference is the diagnosis, shown side by side.
    //
    // One run, not two, when the keys are identical. Once the browser's keys
    // are also stored server-side the two views describe the same setup, and
    // running the sweep twice back-to-back made the first pass eat the cold
    // start and the rate limit: gemini read 失敗 HTTP 0 逾時 in the browser
    // view and 正常 in the schedule view seconds later — the same provider,
    // the same key, presented as a disagreement that wasn't there.
    const storedMap = stored as Record<string, string | undefined>;
    const mergedMap = merged as Record<string, string | undefined>;
    const sameKeys = Object.keys({ ...storedMap, ...mergedMap }).every(
      (k) => storedMap[k] === mergedMap[k],
    );
    const results = await withUserKeys(merged, () => testAIProviders());
    const scheduled = sameKeys ? results : await withUserKeys(stored, () => testAIProviders());
    return json({ ranAt: new Date().toISOString(), results, scheduled });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}

import { json } from "@/lib/json-response";
import { isSettableKey, setSetting, settingsStatus, SETTABLE_KEYS } from "@/lib/settings";
import { getSignalStore } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Reads and writes the alert settings from the browser.
 *
 * Why these can be set from a web form when `DATABASE_URL` and `CRON_SECRET`
 * cannot: the allowlist in lib/settings.ts. Anything not on it is rejected
 * here, so this endpoint can never be talked into writing a credential that
 * grants server authority — the same boundary lib/api-key-names.ts draws for
 * the per-request API keys.
 *
 * GET never returns a token, only whether one is present and where it came
 * from. A stored secret is write-only from the outside.
 */

export async function GET() {
  const store = getSignalStore();
  if (!store) {
    return json(
      {
        error: "未設定資料庫，設定無處可存",
        next: "設定 DATABASE_URL（或 Supabase 金鑰）之後才能儲存設定。",
        settings: [],
      },
      { status: 501 },
    );
  }
  try {
    const snapshot = await settingsStatus();
    return json(
      {
        ...snapshot,
        // A read failure is almost always "the table isn't there yet". Saying
        // so with a 500 stops the page rendering "nothing configured" over a
        // database that was never asked the question successfully.
        next: snapshot.storeError
          ? "app_settings 資料表可能還沒建立。用下方的「建立資料表」按鈕。"
          : undefined,
      },
      { status: snapshot.storeError ? 500 : 200 },
    );
  } catch (err) {
    return json(
      {
        error: err instanceof Error ? err.message : String(err),
        next: "app_settings 資料表可能還沒建立。用下方的「建立資料表」按鈕。",
        settings: [],
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  // Same gate as /api/setup and /api/refresh. When CRON_SECRET is unset the
  // endpoint is open — which is why /setup says so in plain sight rather than
  // leaving it to be discovered.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "請求不是有效的 JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return json({ error: "請求必須是物件" }, { status: 400 });
  }

  const entries = Object.entries(body as Record<string, unknown>);
  const rejected = entries.filter(([key]) => !isSettableKey(key)).map(([key]) => key);
  if (rejected.length > 0) {
    return json(
      {
        error: `不允許設定：${rejected.join("、")}`,
        allowed: SETTABLE_KEYS,
      },
      { status: 400 },
    );
  }

  const saved: string[] = [];
  for (const [key, value] of entries) {
    if (!isSettableKey(key)) continue;
    if (typeof value !== "string") {
      return json({ error: `${key} 必須是字串` }, { status: 400 });
    }
    const trimmed = value.trim();
    // An empty string is a deliberate "turn this channel off", stored as such
    // rather than skipped — otherwise a channel could never be unset.
    try {
      await setSetting(key, trimmed);
      saved.push(key);
    } catch (err) {
      return json(
        {
          error: err instanceof Error ? err.message : String(err),
          next: "app_settings 資料表可能還沒建立。用下方的「建立資料表」按鈕。",
        },
        { status: 500 },
      );
    }
  }

  return json({ saved, ...(await settingsStatus()) });
}

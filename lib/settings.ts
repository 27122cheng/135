import { getSignalStore } from "./db";
import { USER_SETTABLE_KEYS, type UserSettableKey } from "./api-key-names";

/**
 * Settings a browser writes and a scheduler reads.
 *
 * The API keys in lib/api-keys.ts ride along with each request in a header and
 * are never persisted, which works because they're only needed while a request
 * is in flight. The alert channels are the opposite case: they are needed at
 * 04:00 by a GitHub Actions run with no browser anywhere near it. That leaves
 * two options — a Vercel environment variable, which costs a redeploy every
 * time it changes, or the database, which is already there. This is the
 * database one.
 *
 * ## The allowlist is the security boundary
 *
 * Exactly as in lib/api-key-names.ts, and for the same reason: without it, an
 * endpoint that writes "whatever key the client asked for" is an endpoint that
 * writes `DATABASE_URL`. Only the names below can be set from outside, and the
 * credentials that grant server authority — `DATABASE_URL`, `CRON_SECRET`,
 * `SUPABASE_SERVICE_ROLE_KEY` — are deliberately absent and must stay that way.
 */

const ALERT_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "DISCORD_WEBHOOK_URL",
  "ALERT_MIN_GRADE",
] as const;

/**
 * The AI keys are settable here *as well as* per-request, and the two serve
 * different callers.
 *
 * A browser sends them in a header and nothing is stored — that promise still
 * holds for anything you look at on the site. But the 4-hour scan runs with no
 * browser, so it saw no keys at all and fell back to local rules on every
 * scheduled signal, silently producing worse output than the same symbol viewed
 * by hand. Storing them makes the scheduler work; the header still wins when
 * there is one, so a browser's own keys are never overridden by the stored set.
 */
export const SETTABLE_KEYS = [...ALERT_KEYS, ...USER_SETTABLE_KEYS] as const;

export type SettingKey = (typeof SETTABLE_KEYS)[number];

/**
 * Values that must never be echoed back to a client, even to their owner.
 * Anything ending in _KEY or _TOKEN is a credential; the model names and the
 * provider order are configuration and showing them is how you confirm them.
 */
const SECRET_KEYS = new Set<string>([
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_WEBHOOK_URL",
  ...USER_SETTABLE_KEYS.filter((k) => k.endsWith("_KEY")),
]);

export function isSettableKey(key: string): key is SettingKey {
  return (SETTABLE_KEYS as readonly string[]).includes(key);
}

export function isSecretSetting(key: SettingKey): boolean {
  return SECRET_KEYS.has(key);
}

/**
 * Cached per invocation. A serverless function handling one refresh reads these
 * up to a dozen times (once per symbol's alert check); one round trip is
 * plenty, and the process is gone long before a stale value could matter.
 */
let cache: Map<string, string> | null = null;
/**
 * Why the read failed, if it did.
 *
 * `loadAll` has to swallow the error — a missing `app_settings` table must not
 * take down the 4-hourly refresh that happens to read a setting. But swallowing
 * it silently is how a save that failed because the table doesn't exist ends up
 * looking, from the settings page, like "no channels configured": the write
 * reports the real problem and the read quietly reports nothing. So the reason
 * is kept and handed to anyone asking for status.
 */
let lastError: string | null = null;

export function clearSettingsCache(): void {
  cache = null;
  lastError = null;
}

async function loadAll(): Promise<Map<string, string>> {
  if (cache) return cache;
  const store = getSignalStore();
  if (!store) {
    lastError = "未設定資料庫";
    return (cache = new Map());
  }
  try {
    cache = await store.listSettings();
    lastError = null;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    cache = new Map();
  }
  return cache;
}

/**
 * Environment variable first, database second.
 *
 * That order and not the other way round: an operator who has gone to the
 * trouble of setting a Vercel environment variable has made a deliberate
 * deployment-level choice, and a value typed into a web form should not
 * silently override it. It also keeps every existing deployment working
 * unchanged.
 */
export async function getSetting(key: SettingKey): Promise<string | null> {
  const fromEnv = process.env[key]?.trim();
  if (fromEnv) return fromEnv;
  const stored = (await loadAll()).get(key)?.trim();
  return stored || null;
}

export async function setSetting(key: SettingKey, value: string): Promise<void> {
  const store = getSignalStore();
  if (!store) throw new Error("未設定資料庫，無法儲存設定");
  await store.saveSetting(key, value.trim());
  clearSettingsCache();
  // The write that lies, settings edition. Keys were "saved", the settings
  // page showed success, and the hourly sweep still reported 未設定任何 AI
  // 金鑰 — because the database accepted the row and lost it (the per-deploy
  // branch failure). A save that cannot be read back is not a save, and the
  // settings page's red 寫進排程失敗 path is exactly where this belongs.
  try {
    let echo = await store.listSettings();
    if (echo.get(key)?.trim() === value.trim()) return;
    // Neon's HTTP reads can trail a commit by a beat; give the save one
    // re-check before calling it lost, or a healthy save shows a red error.
    await new Promise((resolve) => setTimeout(resolve, 800));
    echo = await store.listSettings();
    if (echo.get(key)?.trim() === value.trim()) return;
  } catch {
    // A read-back that itself fails proves nothing about the write.
    return;
  }
  throw new Error(
    "設定寫入後立刻讀不回 —— 資料庫收下了寫入卻沒有留住（多半是資料庫整合替每個部署開新分支，" +
      "需把 DATABASE_URL 換成固定分支）。替代做法：把這個值直接設成 Vercel 環境變數，" +
      "完全不經資料庫，排程一定讀得到",
  );
}

export interface SettingStatus {
  key: SettingKey;
  configured: boolean;
  /** Where the active value came from — env wins, so this explains surprises. */
  source: "env" | "database" | null;
  /** Non-secret values are echoed; secrets never are. */
  value: string | null;
}

export interface SettingsSnapshot {
  settings: SettingStatus[];
  /** Non-null when the stored settings could not be read at all. */
  storeError: string | null;
}

/** For /setup and /api/diagnostics. Never returns a token. */
export async function settingsStatus(): Promise<SettingsSnapshot> {
  const stored = await loadAll();
  const settings: SettingStatus[] = SETTABLE_KEYS.map((key) => {
    const fromEnv = process.env[key]?.trim();
    const fromDb = stored.get(key)?.trim();
    const source = fromEnv ? "env" : fromDb ? "database" : null;
    return {
      key,
      configured: Boolean(fromEnv || fromDb),
      source,
      value: isSecretSetting(key) ? null : (fromEnv ?? fromDb ?? null),
    };
  });
  return { settings, storeError: lastError };
}

/**
 * The stored API keys, shaped for `withUserKeys`.
 *
 * Used by the scheduled routes so a cron run has the same AI providers a
 * browser would. Environment variables are deliberately *not* merged in here —
 * `getKey` already falls back to them, and duplicating that would invert the
 * precedence.
 */
export async function storedApiKeys(): Promise<Partial<Record<UserSettableKey, string>>> {
  const stored = await loadAll();
  const out: Partial<Record<UserSettableKey, string>> = {};
  for (const name of USER_SETTABLE_KEYS) {
    const value = stored.get(name)?.trim();
    if (value) out[name] = value;
  }
  return out;
}

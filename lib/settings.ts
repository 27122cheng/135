import { getSignalStore } from "./db";

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

export const SETTABLE_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "DISCORD_WEBHOOK_URL",
  "ALERT_MIN_GRADE",
] as const;

export type SettingKey = (typeof SETTABLE_KEYS)[number];

/** Values that must never be echoed back to a client, even to their owner. */
const SECRET_KEYS = new Set<SettingKey>(["TELEGRAM_BOT_TOKEN", "DISCORD_WEBHOOK_URL"]);

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

export function clearSettingsCache(): void {
  cache = null;
}

async function loadAll(): Promise<Map<string, string>> {
  if (cache) return cache;
  const store = getSignalStore();
  if (!store) return (cache = new Map());
  try {
    cache = await store.listSettings();
  } catch {
    // A missing app_settings table must not take down the refresh that reads
    // it — the deployment simply has no stored settings yet.
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
}

export interface SettingStatus {
  key: SettingKey;
  configured: boolean;
  /** Where the active value came from — env wins, so this explains surprises. */
  source: "env" | "database" | null;
  /** Non-secret values are echoed; secrets never are. */
  value: string | null;
}

/** For /setup and /api/diagnostics. Never returns a token. */
export async function settingsStatus(): Promise<SettingStatus[]> {
  const stored = await loadAll();
  return SETTABLE_KEYS.map((key) => {
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
}

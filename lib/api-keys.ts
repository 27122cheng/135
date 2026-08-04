import { AsyncLocalStorage } from "node:async_hooks";
import { USER_SETTABLE_KEYS, type UserSettableKey } from "./api-key-names";

export { USER_SETTABLE_KEYS, type UserSettableKey };

/**
 * Per-request API keys, so a user can paste their own keys into the app
 * instead of setting Vercel environment variables and redeploying.
 *
 * Request-scoped via AsyncLocalStorage rather than threaded through every
 * fetcher, and **never persisted server-side** — the keys live in the
 * caller's browser and travel with each request. Environment variables
 * remain the fallback, so a deployment configured the normal way is
 * unaffected.
 *
 * Only these names are accepted. An arbitrary header key must never be able
 * to override unrelated server configuration (Supabase service role, cron
 * secret), so the allowlist is the security boundary.
 */
const store = new AsyncLocalStorage<Partial<Record<UserSettableKey, string>>>();

/** Runs `fn` with these keys visible to getKey() for its whole async tree. */
export function withUserKeys<T>(
  keys: Partial<Record<UserSettableKey, string>>,
  fn: () => Promise<T>,
): Promise<T> {
  return store.run(keys, fn);
}

/** Request-scoped key if present, otherwise the environment variable. */
export function getKey(name: UserSettableKey): string | undefined {
  const fromRequest = store.getStore()?.[name];
  if (fromRequest && fromRequest.trim()) return fromRequest.trim();
  const fromEnv = process.env[name];
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : undefined;
}

/**
 * Parses the client-supplied key header. Unknown names are dropped rather
 * than passed through, and values are length-capped so a malformed header
 * can't be used to push large payloads into upstream URLs.
 */
export function parseUserKeyHeader(raw: string | null): Partial<Record<UserSettableKey, string>> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const out: Partial<Record<UserSettableKey, string>> = {};
  for (const name of USER_SETTABLE_KEYS) {
    const value = (parsed as Record<string, unknown>)[name];
    if (typeof value === "string" && value.trim() && value.length <= 200) {
      out[name] = value.trim();
    }
  }
  return out;
}

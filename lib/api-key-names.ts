/**
 * Shared between the server key resolver and the client settings page, so it
 * must stay free of Node-only imports — importing the server module from the
 * client would pull node:async_hooks into the browser bundle.
 *
 * This allowlist is the security boundary: only these names can be supplied
 * per-request. An arbitrary header must never be able to override unrelated
 * server configuration such as the Supabase service role key or CRON_SECRET.
 */
export const USER_SETTABLE_KEYS = [
  "TWELVE_DATA_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "FINNHUB_API_KEY",
  "FRED_API_KEY",
  "EIA_API_KEY",
] as const;

export type UserSettableKey = (typeof USER_SETTABLE_KEYS)[number];

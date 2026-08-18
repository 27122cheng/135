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
  // AI providers, free tier first — see lib/ai/index.ts for the fallback order.
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  // Model overrides; free tiers retire model ids fairly often.
  "GEMINI_MODEL",
  "GROQ_MODEL",
  "OPENROUTER_MODEL",
  "AI_PROVIDER_ORDER",
  // Paid, opt-in only. Last in the chain, so a free deployment never reaches it.
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  // Market and macro data.
  "FINNHUB_API_KEY",
  "FRED_API_KEY",
  "EIA_API_KEY",
  // Optional fourth quote source, and the only live one that is neither Yahoo
  // nor Stooq. Without it the chain still works; with it, a Yahoo freeze stops
  // meaning "yesterday's close or nothing".
  "TWELVEDATA_API_KEY",
] as const;

export type UserSettableKey = (typeof USER_SETTABLE_KEYS)[number];

import { getKey } from "@/lib/api-keys";
import { recordFailure, recordSuccess, tryConsume, type QuotaLimit } from "@/lib/data-sources/quota";
import { AIProviderError, type AIProvider, type CompleteOptions, type ResponseSchema } from "./provider";
import { geminiProvider } from "./providers/gemini";
import { openAICompatibleProvider } from "./providers/openai-compatible";
import { anthropicProvider } from "./providers/anthropic";
import { getCached, setCached } from "@/lib/data-sources/cache";

export * from "./provider";

/**
 * The provider registry and fallback chain — the only AI entry point the
 * analysis code is allowed to touch.
 *
 * Order is Gemini → Groq → OpenRouter → Anthropic. The first three are free;
 * Anthropic is paid and sits last so it is never reached unless the free ones
 * are unconfigured or failing. A provider with no key is skipped silently
 * (not a failure — it was never in play).
 */

/**
 * Published free-tier limits. Where the provider documents a number, it is
 * used as-is; where it does not, the value here is a deliberately conservative
 * guess and is marked as such — under-spending costs a fallback hop, while
 * over-spending costs a throttled key.
 */
export const AI_LIMITS: Record<string, QuotaLimit> = {
  // Measured, not documented. The published figure is 1500 req/day, but a live
  // 429 came back reading `limit: 20` for generate_content free-tier requests
  // on gemini-3.6-flash — the free tier is far tighter than the docs page
  // suggests and the exact number moves. 10/min and 200/day is a budget that
  // survives a day of use rather than one that matches a marketing page.
  gemini: { perMinute: 10, perDay: 200 },
  // Groq's real ceiling is **tokens** per day (100,000 on the free tier), not
  // requests, and this quota tracker only counts requests. A trade-plan call is
  // roughly 2–4k tokens, so ~25 requests/day is the honest translation. Getting
  // this wrong is not theoretical: a dashboard rescanning nine symbols burned
  // 98,299 of the 100,000 in an afternoon and every signal afterwards fell back
  // to local rules while looking, on screen, like a normal analysis.
  groq: { perMinute: 20, perDay: 25 },
  // Conservative guess: free `:free` models are rate-limited by account credit
  // and the exact numbers move often. Treated as a last resort anyway.
  openrouter: { perMinute: 20, perDay: 50 },
  // Paid — no free-tier ceiling to respect, just a sane burst guard.
  anthropic: { perMinute: 50 },
};

const DEFAULT_ORDER = ["gemini", "groq", "openrouter", "anthropic"];

function buildRegistry(): Map<string, AIProvider> {
  const providers: AIProvider[] = [
    geminiProvider(),
    openAICompatibleProvider({
      name: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKeyName: "GROQ_API_KEY",
      modelKeyName: "GROQ_MODEL",
      defaultModel: "llama-3.3-70b-versatile",
    }),
    openAICompatibleProvider({
      name: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeyName: "OPENROUTER_API_KEY",
      modelKeyName: "OPENROUTER_MODEL",
      // A `:free` model, per the spec. OpenRouter retires these periodically —
      // override with OPENROUTER_MODEL if this id stops resolving.
      defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
      extraHeaders: { "x-title": "multi-commodity-signal" },
    }),
    anthropicProvider(),
  ];
  return new Map(providers.map((p) => [p.name, p]));
}

/**
 * Rebuilt per call rather than cached at module scope: keys are request-scoped
 * (a user can paste their own in /settings), so a provider captured once would
 * answer isConfigured() for whoever loaded the module first.
 */
function orderedProviders(): AIProvider[] {
  const registry = buildRegistry();
  const raw = getKey("AI_PROVIDER_ORDER");
  const names = raw
    ? raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => registry.has(s))
    : [];
  const order = names.length > 0 ? names : DEFAULT_ORDER;
  return order.map((n) => registry.get(n)).filter((p): p is AIProvider => p !== undefined);
}

export interface AIResult<T> {
  value: T;
  /** Which provider answered — used to label the evidence shown to the user. */
  provider: string;
}

/**
 * Runs the prompt through the chain and returns the first schema-conforming
 * answer, or null when every provider is unconfigured, over quota, or failing.
 *
 * Null is a normal outcome, not an exception: every caller has a deterministic
 * local fallback, because the analysis must not depend on a free tier being up.
 */

/**
 * How long an AI answer stays reusable.
 *
 * Four hours, matching the H4 candle the whole analysis is built on. Inside one
 * bar the inputs genuinely have not moved: same candles, same COT (weekly),
 * same yields (daily). Asking the model the identical question again buys a
 * differently-worded answer to the same facts, and on a free tier it buys it
 * with tokens that are not coming back.
 *
 * This is the single biggest saving available. The dashboard rescans nine
 * symbols every 30 minutes; without this, one open tab is 8 full sweeps per
 * H4 bar — 8× the token spend for one bar's worth of new information.
 */
const AI_CACHE_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * A stable key for "this exact question".
 *
 * djb2 over the schema name and the prompt. Not cryptographic — it only has to
 * separate different prompts, and a collision would serve one symbol another's
 * answer, which the length check makes vanishingly unlikely for prompts that
 * always embed their own symbol.
 */
function promptKey(schemaName: string, prompt: string): string {
  let hash = 5381;
  for (let i = 0; i < prompt.length; i++) {
    hash = ((hash << 5) + hash + prompt.charCodeAt(i)) | 0;
  }
  return `ai:${schemaName}:${prompt.length}:${(hash >>> 0).toString(36)}`;
}

/**
 * Why the AI was not used, for callers that have to explain themselves.
 *
 * `null` from `completeAI` used to be the whole story, so every fallback said
 * the same thing: "未設定 AI 金鑰、額度用盡或呼叫失敗". Three possibilities in
 * one sentence, with the one that blames the reader first — and the reader had
 * in fact set the keys, and the actual cause was a spent free tier. A message
 * that lists what *might* be wrong is worse than no message: it sends someone
 * to check a setting that was never the problem.
 */
export type AiUnavailableReason = "no-key" | "quota" | "error";

export interface AiUnavailable {
  reason: AiUnavailableReason;
  /** One line, already in Chinese, safe to put on the card. */
  message: string;
  /** The raw provider errors, for diagnostics. */
  detail: string;
}

/** 429 / quota / rate-limit wording, across providers that all phrase it differently. */
function looksLikeQuota(text: string): boolean {
  return /429|quota|rate.?limit|too many requests|tokens per day|TPD|額度/i.test(text);
}

function classifyFailure(failures: string[]): AiUnavailable {
  const joined = failures.join("；");
  if (failures.length > 0 && failures.every((f) => looksLikeQuota(f))) {
    return {
      reason: "quota",
      message: "AI 免費額度已用盡（金鑰有設定且有效），本次改用預設規則",
      detail: joined,
    };
  }
  return {
    reason: "error",
    message: "AI 供應商呼叫失敗，本次改用預設規則",
    detail: joined,
  };
}

export async function completeAI<T>(
  prompt: string,
  schema: ResponseSchema<T>,
  gaps: string[],
  options?: CompleteOptions & {
    /** Told why, when the answer is null. Same sink pattern as fetchJson. */
    onUnavailable?: (why: AiUnavailable) => void;
  },
): Promise<AIResult<T> | null> {
  // Identical question, still inside the same H4 bar → reuse the answer.
  // Checked before the provider list so it costs nothing even when every
  // provider is rate-limited: a cached answer is better than a fallback.
  const cacheKey = promptKey(schema.name, prompt);
  const cached = getCached<AIResult<T>>(cacheKey);
  if (cached) return cached;

  const providers = orderedProviders();
  const configured = providers.filter((p) => p.isConfigured());

  if (configured.length === 0) {
    gaps.push(
      "未設定任何 AI 金鑰（GEMINI_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY），AI 環節改用本地規則",
    );
    options?.onUnavailable?.({
      reason: "no-key",
      message: "未設定任何 AI 金鑰，AI 環節改用本地規則",
      detail: "no provider configured",
    });
    return null;
  }

  const failures: string[] = [];
  for (const provider of configured) {
    const decision = tryConsume(provider.name, AI_LIMITS[provider.name] ?? {});
    if (!decision.ok) {
      failures.push(decision.reason);
      continue;
    }
    try {
      const value = await provider.complete(prompt, schema, options);
      recordSuccess(provider.name);
      const result = { value, provider: provider.name };
      setCached(cacheKey, result, AI_CACHE_TTL_MS);
      return result;
    } catch (err) {
      recordFailure(provider.name);
      failures.push(err instanceof AIProviderError ? err.message : String(err));
    }
  }

  const why = classifyFailure(failures);
  gaps.push(`所有 AI 供應商皆無法回應（${failures.join("；")}）`);
  options?.onUnavailable?.(why);
  return null;
}

/** Provider status for /api/diagnostics — never exposes key values. */
export function aiProviderStatus(): Array<{ name: string; tier: string; configured: boolean }> {
  return orderedProviders().map((p) => ({
    name: p.name,
    tier: p.tier,
    configured: p.isConfigured(),
  }));
}

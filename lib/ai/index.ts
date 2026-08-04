import { getKey } from "@/lib/api-keys";
import { recordFailure, recordSuccess, tryConsume, type QuotaLimit } from "@/lib/data-sources/quota";
import { AIProviderError, type AIProvider, type CompleteOptions, type ResponseSchema } from "./provider";
import { geminiProvider } from "./providers/gemini";
import { openAICompatibleProvider } from "./providers/openai-compatible";
import { anthropicProvider } from "./providers/anthropic";

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
const LIMITS: Record<string, QuotaLimit> = {
  // Documented: 1500 req/day. 15 req/min is the published free-tier rate for
  // Flash models — with 3 AI calls per symbol × 9 symbols a refresh run will
  // hit it, which is exactly when the chain should hop to Groq.
  gemini: { perMinute: 15, perDay: 1500 },
  // Documented: 30 req/min. Groq's daily request cap varies by model and was
  // not verifiable at build time, so no perDay is declared rather than a made-up one.
  groq: { perMinute: 30 },
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
export async function completeAI<T>(
  prompt: string,
  schema: ResponseSchema<T>,
  gaps: string[],
  options?: CompleteOptions,
): Promise<AIResult<T> | null> {
  const providers = orderedProviders();
  const configured = providers.filter((p) => p.isConfigured());

  if (configured.length === 0) {
    gaps.push(
      "未設定任何 AI 金鑰（GEMINI_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY），AI 環節改用本地規則",
    );
    return null;
  }

  const failures: string[] = [];
  for (const provider of configured) {
    const decision = tryConsume(provider.name, LIMITS[provider.name] ?? {});
    if (!decision.ok) {
      failures.push(decision.reason);
      continue;
    }
    try {
      const value = await provider.complete(prompt, schema, options);
      recordSuccess(provider.name);
      return { value, provider: provider.name };
    } catch (err) {
      recordFailure(provider.name);
      failures.push(err instanceof AIProviderError ? err.message : String(err));
    }
  }

  gaps.push(`所有 AI 供應商皆無法回應（${failures.join("；")}）`);
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

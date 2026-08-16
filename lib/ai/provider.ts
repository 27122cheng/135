/**
 * The AI abstraction. **This file names no vendor.**
 *
 * Business logic (news sentiment, narrative, trade plan) may import this module
 * and `lib/ai/index.ts` — never a provider implementation, and never a vendor
 * SDK. That is the whole point: the free tiers change their limits and models
 * constantly, so swapping Gemini for Groq must be a registry edit, not a
 * rewrite of the analysis code.
 *
 * ## Privacy
 *
 * Free tiers generally reserve the right to train on submitted prompts. Every
 * prompt built in this project contains only public market data — prices,
 * public news headlines, CFTC positioning, computed scores. Do not add user
 * identity, account balances, position sizes, or anything else private to a
 * prompt without first checking the provider's data-retention terms.
 */

/**
 * A runtime-checked description of the response shape.
 *
 * `instruction` is appended to the prompt so the model knows the format;
 * `parse` is what actually decides whether the reply is usable. A model that
 * answers in the wrong shape is treated as a provider failure and the next
 * provider is tried — the caller never sees a half-parsed object.
 */
export interface ResponseSchema<T> {
  readonly name: string;
  readonly instruction: string;
  parse(raw: string): T | null;
}

/** Thrown by a provider when it cannot produce a schema-conforming answer. */
export class AIProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(`${provider}: ${message}`);
    this.name = "AIProviderError";
  }
}

export interface CompleteOptions {
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /**
   * A stable identity for "this question, this bar" — overrides the default
   * hash-of-the-prompt cache key.
   *
   * The default key was structurally useless. Prompts embed the live price
   * and every current indicator reading, so an hourly sweep produced a
   * different prompt — and therefore a different key — every single time,
   * and the 4-hour AI cache never once hit. Nine symbols × three calls ×
   * hourly is ~430 model calls a day against free tiers that allow between
   * 20 and 1500, which is why every provider ends the day rate-limited.
   *
   * Callers that know the H4 bar the analysis is built on pass
   * `symbol:barTime` instead. Inside one bar the inputs genuinely have not
   * moved — the system's own doctrine says a rescan then "buys a
   * differently-worded answer to identical facts" — so reusing the answer
   * is not a compromise, it is the honest interval applied to the model too.
   */
  cacheKey?: string;
}

export interface AIProvider {
  /** Stable id, also used as the quota bucket name. */
  readonly name: string;
  /** Free tier, or a paid API the user opted into. Surfaced in diagnostics. */
  readonly tier: "free" | "paid";
  /** False when the provider has no key configured, so it is skipped silently. */
  isConfigured(): boolean;
  /** Resolves with a valid T, or throws AIProviderError. */
  complete<T>(prompt: string, schema: ResponseSchema<T>, options?: CompleteOptions): Promise<T>;
}

/** Free-form prose. Rejects an empty reply so a blank answer falls through. */
export function textSchema(instruction: string): ResponseSchema<string> {
  return {
    name: "text",
    instruction,
    parse(raw) {
      const trimmed = raw.trim();
      return trimmed.length > 0 ? trimmed : null;
    },
  };
}

/**
 * A JSON object response. Extracts the first {...} block, because models
 * routinely wrap JSON in prose or a markdown fence no matter what the prompt
 * says. `validate` must check every field the caller depends on.
 */
export function jsonSchema<T>(
  name: string,
  instruction: string,
  validate: (value: Record<string, unknown>) => T | null,
): ResponseSchema<T> {
  return {
    name,
    instruction,
    parse(raw) {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        return null;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      return validate(parsed as Record<string, unknown>);
    },
  };
}

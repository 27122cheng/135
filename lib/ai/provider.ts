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
/**
 * Why a provider did not answer — and specifically, whether backing off from
 * it is the right response.
 *
 * "transport" is the network, the quota, the 503: the provider is unreachable
 * and hitting it again immediately is pointless, so the breaker should open.
 *
 * "content" is a provider that answered fine and said something this schema
 * cannot use. It is up, it is fast, and the next question may well succeed —
 * counting it as a connection failure is both false and expensive. Production
 * showed exactly that cost: one Gemini reply truncated at MAX_TOKENS on the
 * first symbol of a sweep counted as a failure, six of them tripped the
 * breaker, and every symbol after that was told 「gemini 目前連線不穩（已連續
 * 失敗 6 次）」 about a provider that had never once failed to connect. All
 * eleven instruments then ran 新聞面 on keyword scoring.
 */
export type AIFailureKind = "transport" | "content";

export class AIProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    /** Defaults to transport: an unclassified failure is treated as the
     *  cautious case, exactly as every existing throw site intended. */
    readonly kind: AIFailureKind = "transport",
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
   * Wall clock for the whole provider, across every model id it may walk.
   *
   * The per-request timeout alone was not a bound on anything. A provider may
   * try six candidate ids, and a *timeout* on each stacks: six × 25s is two
   * and a half minutes inside a function whose ceiling is sixty seconds. Three
   * symbols died that way — "分析超過 60 秒，Vercel 中斷了這次請求" — while
   * every individual timeout looked reasonable in isolation.
   *
   * Once this is spent the candidate walk stops where it is. A provider that
   * has not answered in twenty seconds is not going to save the scan; the next
   * provider, or the local fallback, is the better use of what remains.
   */
  budgetMs?: number;
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
 * 把被截斷的 JSON 補完 —— salvage a reply the model ran out of budget mid-way
 * through.
 *
 * Every scheduled sweep in production came back with the news dimension dead
 * on all eleven symbols, and the recorded reason was
 * `finishReason=MAX_TOKENS`: the model was still writing when its output
 * budget ran out. The reply was perfectly good up to the cut — score,
 * summary and the first key points all complete — but the extractor below
 * needs a closing brace, so the whole thing parsed as null, the provider
 * threw, and after five or six of those the circuit breaker disabled it for
 * the rest of the sweep. One truncated answer on the first symbol was taking
 * the AI out for every symbol after it, which is why 新聞面 was running on
 * keyword matching (weight capped at 1) everywhere, on every scan.
 *
 * So a truncated object is repaired rather than discarded: scan forward
 * tracking string and nesting state, remember the last point at which the
 * text could be cut without leaving a half-written value, and close whatever
 * is still open. Only ever *removes* trailing incomplete data — it can never
 * invent a field — and `validate` still has the final say, so a repair that
 * lost something the caller needs is rejected exactly as before.
 *
 * Returns null when there is nothing salvageable.
 */
export function repairTruncatedJson(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  const closers: string[] = [];
  let inString = false;
  let escaped = false;
  /** Index (exclusive) of the last cut that leaves a complete value. */
  let safe = -1;
  let safeClosers: string[] = [];
  const mark = (i: number) => {
    safe = i;
    safeClosers = [...closers];
  };

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        inString = false;
        // A string that a colon follows is a KEY, not a value — cutting
        // after it would leave `{"score"` and nothing to repair it with.
        const rest = raw.slice(i + 1).match(/^\s*/)?.[0].length ?? 0;
        if (raw[i + 1 + rest] !== ":") mark(i + 1);
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      closers.push(ch === "{" ? "}" : "]");
      continue;
    }
    if (ch === "}" || ch === "]") {
      closers.pop();
      // A complete object at depth zero needs no repair at all.
      if (closers.length === 0) return raw.slice(start, i + 1);
      mark(i + 1);
      continue;
    }
    // A bare literal (number, true/false/null) is complete once a delimiter
    // follows it; a trailing partial number is left behind by the cut.
    if (/[\w.+-]/.test(ch)) {
      const next = raw[i + 1];
      if (next !== undefined && /[\s,\]}]/.test(next)) mark(i + 1);
    }
  }

  if (safe < 0 || safeClosers.length === 0) return null;
  // Trailing separators would make the repaired text invalid on their own.
  const body = raw.slice(start, safe).replace(/[\s,]+$/, "");
  return body + safeClosers.reverse().join("");
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
      // The whole block when it is there, then the repaired prefix when the
      // model was cut off mid-answer (see repairTruncatedJson).
      const candidates = [raw.match(/\{[\s\S]*\}/)?.[0], repairTruncatedJson(raw)];
      for (const candidate of candidates) {
        if (!candidate) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(candidate);
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        const validated = validate(parsed as Record<string, unknown>);
        if (validated !== null) return validated;
      }
      return null;
    },
  };
}

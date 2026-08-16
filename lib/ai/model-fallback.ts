/**
 * Model-id fallback — because free-tier model ids die young.
 *
 * Every provider here retires model names on its own schedule: Google folds
 * free access to an old Flash into the next one, Groq decommissions Llama
 * versions with a 400 and a sentence, OpenRouter rotates which models carry
 * the `:free` suffix. Each provider was wired to exactly one default id, so
 * the day that id died the provider died with it — and the card said
 * "AI 供應商呼叫失敗" forever, with valid keys, until someone edited code.
 *
 * The cure is a candidate list per provider and the discipline to tell two
 * failures apart: "this model id is gone" walks down the list, anything else
 * (quota, auth, network) aborts to the next *provider*, because retrying a
 * 429 against three model names spends the very quota it is out of.
 */

const workingModel = new Map<string, string>();

/** Candidate ids in the order to try: user override, last known good, defaults. */
export function modelCandidates(
  provider: string,
  override: string | null | undefined,
  defaults: string[],
): string[] {
  const remembered = workingModel.get(provider);
  return [...new Set([override, remembered, ...defaults].filter((m): m is string => Boolean(m)))];
}

/** Remembered per process, so one dead default costs one probe, not one per call. */
export function rememberModel(provider: string, model: string): void {
  workingModel.set(provider, model);
}

/**
 * Whether an HTTP failure means the *model id* is invalid or retired — the
 * only condition under which trying the next id can help.
 */
export function isModelError(status: number, detail: string): boolean {
  if (status === 404) return true;
  if (status !== 400) return false;
  return /decommission|deprecat|not found|does not exist|unknown model|invalid model|no longer (supported|available)|model_not_found|not supported for/i.test(
    detail,
  );
}

/**
 * Whether a 429 is a *per-model* quota that a sibling model escapes.
 *
 * The blanket rule used to be "any 429 aborts the provider", on the theory
 * that retrying spends the quota being rationed. Live errors disproved half
 * of it: Gemini meters free requests per model per day ("Quota exceeded …
 * model: gemini-3.6-flash, limit: 20") and Groq meters tokens per model per
 * day ("Rate limit reached for model `llama-3.3-70b-versatile` … TPD") — a
 * different model id has a separate allowance, so walking the candidate list
 * genuinely helps. Per-*minute* rate limits stay provider-fatal: every model
 * shares the clock, and three probes in the same minute is spending exactly
 * what ran out.
 */
/**
 * How long a rate-limit response asked us to wait, in milliseconds.
 *
 * Groq's 429 states it outright — "Please try again in 19.98s" — and that
 * sentence was being thrown away with the rest of the error, so a per-minute
 * limit that would have cleared in twenty seconds cost the whole analysis its
 * AI and dropped it onto local rules for the next four hours of cache. When
 * the wait is short enough to sit inside the function's own budget, waiting
 * it out is strictly better than falling back.
 *
 * Returns null when no wait is stated, or when the stated wait is too long to
 * be worth blocking a serverless invocation on — the caller then falls back
 * as before. Deliberately capped rather than trusted: a provider answering
 * "try again in 900s" must not hold a 60-second function open.
 */
export const MAX_RETRY_WAIT_MS = 22_000;

export function retryAfterMs(detail: string, headerValue?: string | null): number | null {
  // The standard header first — it is machine-readable and unambiguous.
  if (headerValue) {
    const seconds = Number.parseFloat(headerValue);
    if (Number.isFinite(seconds) && seconds > 0) {
      const ms = seconds * 1000;
      return ms <= MAX_RETRY_WAIT_MS ? Math.ceil(ms) : null;
    }
  }
  const match = /try again in ([\d.]+)\s*(ms|s|m)\b/i.exec(detail);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2].toLowerCase();
  const ms = unit === "ms" ? value : unit === "m" ? value * 60_000 : value * 1000;
  return ms <= MAX_RETRY_WAIT_MS ? Math.ceil(ms) : null;
}

export function isPerModelQuotaError(status: number, detail: string): boolean {
  if (status !== 429) return false;
  if (/per day|per-day|TPD|RPD|daily/i.test(detail)) return true;
  return /quota|billing/i.test(detail) && !/per min|minute|RPM/i.test(detail);
}

export function __resetModelMemoryForTests(): void {
  workingModel.clear();
}

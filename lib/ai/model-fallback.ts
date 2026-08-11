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

export function __resetModelMemoryForTests(): void {
  workingModel.clear();
}

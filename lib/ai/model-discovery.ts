import { fetchJson } from "@/lib/data-sources/http";

/**
 * 問供應商現在有什麼模型，而不是猜。
 *
 * ## The failure this replaces
 *
 * Every provider here retires model ids on its own schedule, and the code
 * carried a hardcoded preference list per provider. When the list goes stale
 * the whole provider dies at once, and the only cure is someone noticing and
 * redeploying. That is exactly what happened: Groq answered
 * `The model 'llama-3.1-8b-instant' does not exist or you do not have access
 * to it` for every id on the list, OpenRouter answered `unavailable for free`
 * for all five, and the site ran on local fallback text for days while looking,
 * on screen, like a normal analysis.
 *
 * Both of those errors are the provider *telling us it has a catalogue*. Every
 * OpenAI-compatible service exposes `GET /models`, and Gemini exposes the same
 * thing at `v1beta/models` — scoped to the caller's key, so the answer is not
 * "what exists" but "what this account may actually call". That is strictly
 * better information than any list committed to a repo.
 *
 * ## Discovery informs the order; it does not replace the fallback
 *
 * The hardcoded list stays as the preference ranking and as the answer when
 * discovery itself fails (no network, an endpoint that changes shape). What
 * discovery adds is: drop ids the account cannot call, and append the ones it
 * can that nobody thought to list. A provider can then survive a rename
 * without a deploy.
 *
 * Cached per process for an hour — a catalogue does not change per request,
 * and a lookup on every AI call would spend more requests on discovery than on
 * analysis.
 */

const TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; models: string[] }>();

/** Ids that answer chat completions but are useless here, in any provider. */
const UNUSABLE = /embed|whisper|tts|guard|moderation|vision|image|audio|rerank|dall|sora|veo/i;

function cached(key: string): string[] | null {
  const hit = cache.get(key);
  if (!hit || Date.now() - hit.at > TTL_MS) return null;
  return hit.models;
}

function remember(key: string, models: string[]): string[] {
  cache.set(key, { at: Date.now(), models });
  return models;
}

/** Test seam: discovery is a network call and every suite must be offline. */
export function clearDiscoveryCache(): void {
  cache.clear();
}

interface OpenAIModelList {
  data?: Array<{
    id?: string;
    /** OpenRouter only: "0" on both means the model is free to call. */
    pricing?: { prompt?: string; completion?: string };
  }>;
}

/**
 * The chat models an OpenAI-compatible account can currently call.
 *
 * `freeOnly` is for OpenRouter, whose catalogue is mostly paid: the pricing
 * fields are strings, and a model is free exactly when both are numerically
 * zero. Groq returns no pricing, so the filter is skipped there rather than
 * being allowed to empty the list.
 */
export async function discoverOpenAICompatibleModels(
  baseUrl: string,
  apiKey: string,
  freeOnly: boolean,
  extraHeaders?: Record<string, string>,
): Promise<string[]> {
  const key = `${baseUrl}:${freeOnly}`;
  const hit = cached(key);
  if (hit) return hit;

  const data = await fetchJson<OpenAIModelList>(
    `${baseUrl}/models`,
    { headers: { authorization: `Bearer ${apiKey}`, ...extraHeaders } },
    10000,
  ).catch(() => null);
  const rows = data?.data;
  if (!Array.isArray(rows)) return remember(key, []);

  const zero = (v: string | undefined) => v !== undefined && Number(v) === 0;
  const models = rows
    .filter((m) => typeof m.id === "string" && !UNUSABLE.test(m.id))
    .filter((m) => {
      if (!freeOnly) return true;
      // No pricing block at all: the provider does not publish it, so the
      // free filter cannot be applied and must not silently drop everything.
      if (!m.pricing) return true;
      return zero(m.pricing.prompt) && zero(m.pricing.completion);
    })
    .map((m) => m.id!);
  return remember(key, models);
}

interface GeminiModelList {
  models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
}

/** Gemini models this key may call for generateContent, newest-looking first. */
export async function discoverGeminiModels(apiKey: string): Promise<string[]> {
  const hit = cached("gemini");
  if (hit) return hit;

  const data = await fetchJson<GeminiModelList>(
    "https://generativelanguage.googleapis.com/v1beta/models",
    { headers: { "x-goog-api-key": apiKey } },
    10000,
  ).catch(() => null);
  const rows = data?.models;
  if (!Array.isArray(rows)) return remember("gemini", []);

  const models = rows
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => (m.name ?? "").replace(/^models\//, ""))
    .filter((id) => id.length > 0 && !UNUSABLE.test(id));
  return remember("gemini", models);
}

/**
 * Merges a preference list with what the account can actually call.
 *
 * Preferred ids that survive discovery come first and in their original order —
 * the ranking encodes cost and quality knowledge discovery cannot see. Then the
 * rest of the catalogue, so a renamed model is reachable without a deploy.
 * `flash`/`instant`/`mini`-style ids are pulled to the front of that remainder:
 * everything this app asks for is a short structured answer, and the small fast
 * models are both cheaper against a token-per-day quota and less likely to be
 * the one the account is rate-limited on.
 *
 * An empty discovery result means discovery failed, not that the account has no
 * models — so the preference list is returned untouched.
 */
export function mergeModelPreference(preferred: string[], discovered: string[]): string[] {
  if (discovered.length === 0) return preferred;
  const available = new Set(discovered);
  const kept = preferred.filter((m) => available.has(m));
  const small = /flash|instant|mini|small|lite|8b|9b|12b|17b|20b|24b|27b/i;
  const rest = discovered
    .filter((m) => !preferred.includes(m))
    .sort((a, b) => Number(small.test(b)) - Number(small.test(a)));
  const merged = [...kept, ...rest];
  // A hard cap: each dead id costs a round trip, and walking forty of them
  // would turn one failed call into a minute of retries.
  return merged.slice(0, 6);
}

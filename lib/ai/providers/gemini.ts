import { getKey } from "@/lib/api-keys";
import { postJson } from "../http";
import { isModelError, isPerModelQuotaError, modelCandidates, rememberModel } from "../model-fallback";
import { discoverGeminiModels, mergeModelPreference } from "../model-discovery";
import { AIProviderError, type AIProvider, type CompleteOptions, type ResponseSchema } from "../provider";

/**
 * Google Gemini — the primary free provider. 1500 req/day on the free tier,
 * 1M-token context, and no credit card required.
 *
 * Deliberately plain `fetch`, not @google/generative-ai: the SDK would be a
 * second way to express the same three fields, and the point of the provider
 * interface is that no vendor's shape leaks past this file.
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
/**
 * In preference order. Google retires free access to old Flash models on its
 * own schedule; when the first id dies the next is tried, and the alias at
 * the end tracks whatever Google currently calls its default Flash.
 */
const DEFAULT_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest"];

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  error?: { message?: string };
}

export function geminiProvider(): AIProvider {
  return {
    name: "gemini",
    tier: "free",
    isConfigured: () => Boolean(getKey("GEMINI_API_KEY")),
    async complete<T>(
      prompt: string,
      schema: ResponseSchema<T>,
      options: CompleteOptions = {},
    ): Promise<T> {
      const apiKey = getKey("GEMINI_API_KEY");
      if (!apiKey) throw new AIProviderError("gemini", "未設定 GEMINI_API_KEY");
      const override = getKey("GEMINI_MODEL");
      /** Carried out of the closure below; TS cannot narrow across one. */
      const answer: { body: GeminiResponse | null; answered: boolean } = {
        body: null,
        answered: false,
      };
      let lastModelError: string | null = null;
      const tried = new Set<string>();
      const ask = (model: string, withThinking: boolean) =>
        postJson(
          `${ENDPOINT}/${encodeURIComponent(model)}:generateContent`,
          { "x-goog-api-key": apiKey },
          {
            contents: [{ parts: [{ text: `${prompt}\n\n${schema.instruction}` }] }],
            generationConfig: {
              maxOutputTokens: options.maxTokens ?? 900,
              temperature: options.temperature ?? 0.2,
              // 2.5 Flash is a thinking model: left on, reasoning tokens eat the
              // output budget and the reply can come back with an empty text
              // part. Nothing here needs chain-of-thought, so it is switched off.
              ...(withThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
            },
          },
          options.timeoutMs ?? 25000,
        );
      const attempt = async (models: string[]): Promise<void> => {
      for (const model of models) {
        if (answer.answered) return;
        if (tried.has(model)) continue;
        tried.add(model);
        let res = await ask(model, true);
        // Not every Flash generation accepts thinkingConfig; the ones that
        // don't answer "HTTP 400 Request contains an invalid argument" — seen
        // live on the settings page's test button — and that must cost a
        // retry without the field, not the whole provider.
        {
          const detail = (res.json as GeminiResponse | null)?.error?.message ?? res.detail ?? "";
          if (!res.ok && res.status === 400 && /invalid argument|INVALID_ARGUMENT|thinking/i.test(detail)) {
            res = await ask(model, false);
          }
        }

        if (!res.ok) {
          const detail = (res.json as GeminiResponse | null)?.error?.message ?? res.detail;
          // A retired model id walks down the list, and so does a per-model
          // daily quota — Gemini meters free requests per model, so
          // gemini-3.6-flash being spent (limit 20/day, seen live) says
          // nothing about gemini-2.5-flash's separate allowance. Per-minute
          // rate limits still abort the provider: all models share the clock.
          if (isModelError(res.status, detail ?? "") || isPerModelQuotaError(res.status, detail ?? "")) {
            lastModelError = `${model}: HTTP ${res.status} ${detail}`;
            continue;
          }
          throw new AIProviderError("gemini", `HTTP ${res.status} ${detail}`);
        }

        rememberModel("gemini", model);
        answer.body = res.json as GeminiResponse | null;
        answer.answered = true;
        return;
      }
      };

      await attempt(modelCandidates("gemini", override, DEFAULT_MODELS));

      // The catalogue lookup happens only after every known id has been
      // refused. Doing it up front cost a round trip on every cold invocation
      // — and /api/scan runs inside a 60-second ceiling that a nine-symbol
      // sweep was already brushing against. Google renames Flash models faster
      // than anyone redeploys and meters the free tier per model per day, so
      // the lookup is worth making; it is not worth making before it is needed.
      if (!answer.answered && !override) {
        const discovered = await discoverGeminiModels(apiKey);
        if (discovered.length > 0) {
          await attempt(mergeModelPreference(DEFAULT_MODELS, discovered));
        }
      }

      if (!answer.answered) {
        throw new AIProviderError(
          "gemini",
          `可用模型皆已下架或改名（${lastModelError ?? "無回應"}），可在設定頁以 GEMINI_MODEL 指定新型號`,
        );
      }
      const body = answer.body;
      const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      const parsed = schema.parse(text);
      if (parsed === null) {
        const finish = body?.candidates?.[0]?.finishReason;
        throw new AIProviderError(
          "gemini",
          `回應不符合 ${schema.name} 格式${finish ? `（finishReason=${finish}）` : ""}`,
        );
      }
      return parsed;
    },
  };
}

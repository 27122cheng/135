import { getKey } from "@/lib/api-keys";
import { postJson } from "../http";
import { isModelError, modelCandidates, rememberModel } from "../model-fallback";
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
      const models = modelCandidates("gemini", getKey("GEMINI_MODEL"), DEFAULT_MODELS);

      let body: GeminiResponse | null = null;
      let lastModelError: string | null = null;
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
      for (const model of models) {
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
          // A retired model id walks down the list; anything else (quota,
          // auth, network) aborts to the next provider — retrying a 429
          // against three names spends the quota it is out of.
          if (isModelError(res.status, detail ?? "")) {
            lastModelError = `${model}: HTTP ${res.status} ${detail}`;
            continue;
          }
          throw new AIProviderError("gemini", `HTTP ${res.status} ${detail}`);
        }

        rememberModel("gemini", model);
        body = res.json as GeminiResponse | null;
        break;
      }
      if (body === null) {
        throw new AIProviderError(
          "gemini",
          `可用模型皆已下架或改名（${lastModelError ?? "無回應"}），可在設定頁以 GEMINI_MODEL 指定新型號`,
        );
      }
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

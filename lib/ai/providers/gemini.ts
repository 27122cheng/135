import { getKey } from "@/lib/api-keys";
import { postJson } from "../http";
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
const DEFAULT_MODEL = "gemini-2.5-flash";

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
      const model = getKey("GEMINI_MODEL") ?? DEFAULT_MODEL;

      const res = await postJson(
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
            thinkingConfig: { thinkingBudget: 0 },
          },
        },
        options.timeoutMs ?? 25000,
      );

      if (!res.ok) {
        const detail = (res.json as GeminiResponse | null)?.error?.message ?? res.detail;
        throw new AIProviderError("gemini", `HTTP ${res.status} ${detail}`);
      }

      const body = res.json as GeminiResponse | null;
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

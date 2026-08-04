import { getKey } from "@/lib/api-keys";
import type { UserSettableKey } from "@/lib/api-key-names";
import { postJson } from "../http";
import { AIProviderError, type AIProvider, type CompleteOptions, type ResponseSchema } from "../provider";

/**
 * Groq and OpenRouter both speak the OpenAI chat-completions shape, so they are
 * one implementation with different base URLs — adding a third such service is
 * a four-line config entry, not a new file.
 */

interface ChatResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  error?: { message?: string };
}

export interface OpenAICompatibleConfig {
  name: string;
  baseUrl: string;
  apiKeyName: UserSettableKey;
  modelKeyName: UserSettableKey;
  defaultModel: string;
  /** Extra headers — OpenRouter asks callers to identify themselves. */
  extraHeaders?: Record<string, string>;
}

export function openAICompatibleProvider(config: OpenAICompatibleConfig): AIProvider {
  return {
    name: config.name,
    tier: "free",
    isConfigured: () => Boolean(getKey(config.apiKeyName)),
    async complete<T>(
      prompt: string,
      schema: ResponseSchema<T>,
      options: CompleteOptions = {},
    ): Promise<T> {
      const apiKey = getKey(config.apiKeyName);
      if (!apiKey) throw new AIProviderError(config.name, `未設定 ${config.apiKeyName}`);
      const model = getKey(config.modelKeyName) ?? config.defaultModel;

      const res = await postJson(
        `${config.baseUrl}/chat/completions`,
        { authorization: `Bearer ${apiKey}`, ...config.extraHeaders },
        {
          model,
          messages: [{ role: "user", content: `${prompt}\n\n${schema.instruction}` }],
          max_tokens: options.maxTokens ?? 900,
          temperature: options.temperature ?? 0.2,
        },
        options.timeoutMs ?? 25000,
      );

      if (!res.ok) {
        const detail = (res.json as ChatResponse | null)?.error?.message ?? res.detail;
        throw new AIProviderError(config.name, `HTTP ${res.status} ${detail}`);
      }

      const body = res.json as ChatResponse | null;
      const text = body?.choices?.[0]?.message?.content ?? "";
      const parsed = schema.parse(text);
      if (parsed === null) {
        throw new AIProviderError(config.name, `回應不符合 ${schema.name} 格式`);
      }
      return parsed;
    },
  };
}

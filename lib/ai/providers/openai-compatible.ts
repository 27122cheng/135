import { getKey } from "@/lib/api-keys";
import type { UserSettableKey } from "@/lib/api-key-names";
import { postJson } from "../http";
import {
  isModelError,
  isPerModelQuotaError,
  modelCandidates,
  rememberModel,
  retryAfterMs,
} from "../model-fallback";
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
  /**
   * In preference order. Groq decommissions Llama versions with a 400 and a
   * sentence; OpenRouter rotates which ids carry `:free`. One dead id must
   * cost a hop to the next, not the provider.
   */
  defaultModels: string[];
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
      const models = modelCandidates(config.name, getKey(config.modelKeyName), config.defaultModels);

      let body: ChatResponse | null = null;
      let lastModelError: string | null = null;
      /** One short wait per call, not per model — see retryAfterMs. */
      let waited = false;
      for (const model of models) {
        const ask = () =>
          postJson(
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
        let res = await ask();

        // A per-minute limit that clears in twenty seconds is not a reason to
        // spend the next four hours on local rules. Groq states the wait in
        // the error itself; if it is short, take it — once.
        if (!res.ok && res.status === 429 && !waited) {
          const detail = (res.json as ChatResponse | null)?.error?.message ?? res.detail ?? "";
          const wait = retryAfterMs(detail);
          if (wait !== null) {
            waited = true;
            await new Promise((resolve) => setTimeout(resolve, wait));
            res = await ask();
          }
        }

        if (!res.ok) {
          const detail = (res.json as ChatResponse | null)?.error?.message ?? res.detail;
          // Dead id or a per-model daily quota: either way the *next* id can
          // succeed where this one cannot. Anything else aborts the provider.
          if (isModelError(res.status, detail ?? "") || isPerModelQuotaError(res.status, detail ?? "")) {
            lastModelError = `${model}: HTTP ${res.status} ${detail}`;
            continue;
          }
          throw new AIProviderError(config.name, `HTTP ${res.status} ${detail}`);
        }

        rememberModel(config.name, model);
        body = res.json as ChatResponse | null;
        break;
      }
      if (body === null) {
        // OpenRouter's answer changed meaning in Aug 2026: five :free ids
        // across five vendors all came back "unavailable for free. The paid
        // version is available" — that is the free program (or this account's
        // access to it) being withdrawn, not a model rename, and telling the
        // owner to hunt for another slug would send them in circles.
        const freeWithdrawn = /unavailable for free/i.test(lastModelError ?? "");
        throw new AIProviderError(
          config.name,
          freeWithdrawn
            ? `此帳戶目前沒有可用的免費模型（官方回覆：free 版已停用、僅剩付費版）。` +
              `這不是設定錯誤 —— 其他 AI 供應商正常時可忽略此項；要用 ${config.name} 就儲值後以 ` +
              `${config.modelKeyName} 指定付費型號（最後嘗試：${lastModelError}）`
            : `可用模型皆已下架或改名（${lastModelError ?? "無回應"}），可在設定頁以 ${config.modelKeyName} 指定新型號`,
        );
      }
      const text = body?.choices?.[0]?.message?.content ?? "";
      const parsed = schema.parse(text);
      if (parsed === null) {
        throw new AIProviderError(config.name, `回應不符合 ${schema.name} 格式`);
      }
      return parsed;
    },
  };
}

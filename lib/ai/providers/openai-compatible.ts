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
import { discoverOpenAICompatibleModels, mergeModelPreference } from "../model-discovery";
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
  /**
   * Whether the catalogue must be filtered to models that cost nothing.
   * OpenRouter's is mostly paid; Groq's free tier publishes no pricing at all,
   * so filtering there would empty the list.
   */
  freeOnly?: boolean;
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
      const override = getKey(config.modelKeyName);

      /** Set by `attempt` when a model answered — see the note below on why. */
      const answer: { body: ChatResponse | null; answered: boolean } = {
        body: null,
        answered: false,
      };
      let lastModelError: string | null = null;
      /** One short wait per call, not per model — see retryAfterMs. */
      let waited = false;
      const tried = new Set<string>();
      // See CompleteOptions.budgetMs: the per-request timeout bounds one call,
      // not the walk over six candidate ids.
      const deadline = Date.now() + (options.budgetMs ?? 20000);

      /** Walks a candidate list; returns true when one of them answered. */
      const attempt = async (models: string[]): Promise<boolean> => {
      for (const model of models) {
        if (tried.has(model)) continue;
        if (Date.now() > deadline) {
          lastModelError = `${lastModelError ?? ""}（已用盡 ${config.name} 的時間預算，未再試其餘型號）`;
          break;
        }
        tried.add(model);
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
            // Bounded by whatever is left of the budget, so the last attempt
            // cannot overrun it by a full timeout.
            Math.max(3000, Math.min(options.timeoutMs ?? 15000, deadline - Date.now())),
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
        answer.body = res.json as ChatResponse | null;
        answer.answered = true;
        return true;
      }
      return false;
      };

      await attempt(modelCandidates(config.name, override, config.defaultModels));

      // Only now ask the account what it can actually call.
      //
      // Discovery was originally done up front, and that was a latency bug: on
      // a cold serverless invocation the per-process cache is empty, so every
      // scan paid a catalogue lookup per provider before its first token — and
      // /api/scan lives inside a 60-second ceiling that a nine-symbol board was
      // already brushing against. The healthy path now costs nothing extra: the
      // committed list is tried first and almost always answers. The lookup
      // happens only once every id on it has been refused, which is exactly the
      // failure it exists to repair (Groq: "the model does not exist or you do
      // not have access to it", for every name we knew).
      if (!answer.answered && !override) {
        const discovered = await discoverOpenAICompatibleModels(
          config.baseUrl,
          apiKey,
          config.freeOnly ?? false,
          config.extraHeaders,
        );
        if (discovered.length > 0) {
          await attempt(mergeModelPreference(config.defaultModels, discovered));
        }
      }

      if (!answer.answered) {
        // OpenRouter's answer changed meaning in Aug 2026: five :free ids
        // across five vendors all came back "unavailable for free. The paid
        // version is available" — that is the free program (or this account's
        // access to it) being withdrawn, not a model rename, and telling the
        // owner to hunt for another slug would send them in circles.
        const freeWithdrawn = /unavailable for free/i.test(lastModelError ?? "");
        throw new AIProviderError(
          config.name,
          freeWithdrawn
            ? `此帳戶目前沒有可用的免費模型（已直接向 ${config.name} 查詢型號清單，仍無免費可用）。` +
              `這不是設定錯誤 —— 其他 AI 供應商正常時可忽略此項；要用 ${config.name} 就儲值後以 ` +
              `${config.modelKeyName} 指定付費型號（最後嘗試：${lastModelError}）`
            : `可用模型皆已下架或改名（${lastModelError ?? "無回應"}），可在設定頁以 ${config.modelKeyName} 指定新型號`,
        );
      }
      let body = answer.body;
      let text = body?.choices?.[0]?.message?.content ?? "";
      let parsed = schema.parse(text);

      // 空回應而且是被 max_tokens 截斷的，多給一次預算。
      //
      // OpenRouter's free ids are increasingly reasoning models, which spend
      // the output budget thinking and return `content: ""` with
      // finish_reason "length" — the live sweep logged this as 「openrouter:
      // 回應不符合 text 格式」 on every symbol. That is not a broken model,
      // it is a budget three times too small for the model that answered.
      // One retry at triple the budget, on the id that just answered, inside
      // the same deadline; mirrors the gemini MAX_TOKENS retry.
      const cutOff =
        (body?.choices?.[0] as { finish_reason?: string } | undefined)?.finish_reason === "length";
      const answeredBy = [...tried].pop();
      if (parsed === null && cutOff && answeredBy && Date.now() < deadline) {
        const retry = await postJson(
          `${config.baseUrl}/chat/completions`,
          { authorization: `Bearer ${apiKey}`, ...config.extraHeaders },
          {
            model: answeredBy,
            messages: [{ role: "user", content: `${prompt}\n\n${schema.instruction}` }],
            max_tokens: (options.maxTokens ?? 900) * 3,
            temperature: options.temperature ?? 0.2,
          },
          Math.max(3000, Math.min(options.timeoutMs ?? 15000, deadline - Date.now())),
        );
        if (retry.ok) {
          body = retry.json as ChatResponse | null;
          text = body?.choices?.[0]?.message?.content ?? "";
          parsed = schema.parse(text);
        }
      }

      if (parsed === null) {
        throw new AIProviderError(
          config.name,
          `回應不符合 ${schema.name} 格式${cutOff ? "（finish_reason=length，輸出被截斷）" : ""}`,
          "content",
        );
      }
      return parsed;
    },
  };
}

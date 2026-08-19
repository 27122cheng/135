import { getKey } from "@/lib/api-keys";
import { postJson } from "../http";
import { AIProviderError, type AIProvider, type CompleteOptions, type ResponseSchema } from "../provider";

/**
 * Anthropic — the one paid provider, kept only as an opt-in.
 *
 * It is last in the default order and skipped entirely when no key is set, so
 * a free-tier deployment never reaches it and never spends money. It stays in
 * the registry because the whole point of the interface is that the choice is
 * the operator's, and someone who already pays for a key should be able to use
 * it without patching the analysis code.
 *
 * Via `fetch` rather than @anthropic-ai/sdk — that dependency was dropped when
 * this layer landed, so no vendor SDK ships in the bundle.
 */

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-haiku-4-5";

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string };
}

export function anthropicProvider(): AIProvider {
  return {
    name: "anthropic",
    tier: "paid",
    isConfigured: () => Boolean(getKey("ANTHROPIC_API_KEY")),
    async complete<T>(
      prompt: string,
      schema: ResponseSchema<T>,
      options: CompleteOptions = {},
    ): Promise<T> {
      const apiKey = getKey("ANTHROPIC_API_KEY");
      if (!apiKey) throw new AIProviderError("anthropic", "未設定 ANTHROPIC_API_KEY");
      const model = getKey("ANTHROPIC_MODEL") ?? DEFAULT_MODEL;

      const res = await postJson(
        ENDPOINT,
        { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        {
          model,
          max_tokens: options.maxTokens ?? 900,
          temperature: options.temperature ?? 0.2,
          messages: [{ role: "user", content: `${prompt}\n\n${schema.instruction}` }],
        },
        Math.min(options.timeoutMs ?? 15000, options.budgetMs ?? 20000),
      );

      if (!res.ok) {
        const detail = (res.json as AnthropicResponse | null)?.error?.message ?? res.detail;
        throw new AIProviderError("anthropic", `HTTP ${res.status} ${detail}`);
      }

      const body = res.json as AnthropicResponse | null;
      const text = (body?.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      const parsed = schema.parse(text);
      if (parsed === null) {
        throw new AIProviderError("anthropic", `回應不符合 ${schema.name} 格式`);
      }
      return parsed;
    },
  };
}

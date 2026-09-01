import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, report } from "./_harness";
import { AIProviderError, jsonSchema, repairTruncatedJson } from "@/lib/ai/provider";

/**
 * 為什麼十一個商品的新聞面全都是關鍵字評分.
 *
 * Every scheduled sweep in production came back the same way on every single
 * instrument:
 *
 *   所有 AI 供應商皆無法回應（gemini: 回應不符合 news-analysis 格式
 *   （finishReason=MAX_TOKENS）；groq: 回應不符合 news-analysis 格式；
 *   openrouter: HTTP 0 逾時 8011ms）
 *   → 新聞面改用本地關鍵字評分（準確度低於 AI 評分，權重上限 1）
 *
 * One of six dimensions, capped at weight 1, on all eleven symbols, on every
 * scan. That is a direct hit to both trade volume (fewer dimensions can align,
 * so grades stay below the entry bar) and to win rate (a whole dimension
 * running on keyword matching).
 *
 * Two compounding causes, both fixed here:
 *
 *  1. MAX_TOKENS means the model was still writing when its budget ran out.
 *     The reply was good up to the cut, but the extractor needed a closing
 *     brace, so a usable answer was thrown away whole.
 *  2. That throw counted as a *connection* failure. Six of them tripped the
 *     backoff breaker, and every symbol after that was told 「gemini 目前連線
 *     不穩」 about a provider that had never failed to connect. One truncated
 *     reply on the first symbol took the AI out for all the rest.
 */

// ── the repair ────────────────────────────────────────────────────
{
  const parses = (s: string | null) => {
    if (s === null) return false;
    try {
      JSON.parse(s);
      return true;
    } catch {
      return false;
    }
  };

  // Cut in the middle of a string, deep inside a nested array.
  const midString =
    '{"score":0.4,"summary":"美元走弱","key_points":[{"point":"Fed 偏鴿","impact":"long",' +
    '"sources":[0,1]},{"point":"油價';
  check("a reply cut mid-string repairs to valid JSON", parses(repairTruncatedJson(midString)));
  check("and keeps the points that did complete",
    JSON.parse(repairTruncatedJson(midString)!).key_points.length === 1,
    repairTruncatedJson(midString));

  // Cut right after a comma — the separator must not survive the repair.
  check("a trailing comma is trimmed",
    parses(repairTruncatedJson('{"score":0.4,"summary":"x","key_points":[{"point":"a"},')),
    repairTruncatedJson('{"score":0.4,"summary":"x","key_points":[{"point":"a"},'));
  // Cut mid-number.
  check("a half-written number is dropped rather than misread",
    JSON.parse(repairTruncatedJson('{"score":0.4,"summary":"x","extra":12')!).extra === undefined);

  // The load-bearing distinction: a closing quote followed by a colon is a
  // KEY, and cutting there would leave `{"score"` with nothing to repair.
  check("a cut straight after a key yields nothing, not invalid JSON",
    repairTruncatedJson('{"score":') === null);
  check("no object at all yields nothing", repairTruncatedJson("sorry, I cannot") === null);

  // A complete object must come back untouched, and surrounding prose or a
  // markdown fence must not confuse it.
  const whole = '{"score":-0.2,"summary":"風險趨避","key_points":[]}';
  check("a complete object is returned as-is", repairTruncatedJson(`noise ${whole} more`) === whole);
  check("a fenced object is unwrapped",
    repairTruncatedJson("```json\n" + whole + "\n```") === whole);

  // The repair can only ever *remove* trailing data — it must never invent a
  // field the model did not send.
  const repaired = JSON.parse(repairTruncatedJson(midString)!);
  check("the repair invents nothing", repaired.score === 0.4 && repaired.summary === "美元走弱");
}

// ── the schema still has the final say ────────────────────────────
{
  const schema = jsonSchema<{ score: number; summary: string; points: number }>(
    "news-analysis",
    "",
    (v) =>
      typeof v.score === "number" && typeof v.summary === "string"
        ? {
            score: v.score,
            summary: v.summary,
            points: Array.isArray(v.key_points) ? v.key_points.length : 0,
          }
        : null,
  );

  const truncated =
    '{"score":0.4,"summary":"美元走弱","key_points":[{"point":"Fed 偏鴿","impact":"long",' +
    '"sources":[0,1]},{"point":"油';
  const got = schema.parse(truncated);
  check("a truncated news reply now parses instead of failing the provider",
    got?.score === 0.4 && got.summary === "美元走弱", got);
  check("with the key points that survived the cut", got?.points === 1, got);

  // A repair that loses a field the caller needs is still a failure — the
  // salvage must not lower the bar, only widen what can clear it.
  check("a repair missing a required field is still rejected",
    schema.parse('{"key_points":[{"point":"a"},') === null);
  check("prose is still rejected", schema.parse("I'm sorry, I can't help") === null);
  check("a complete reply is unaffected",
    schema.parse('{"score":1,"summary":"s","key_points":[]}')?.score === 1);
}

// ── content failures must not open the breaker ────────────────────
{
  check("an unclassified failure still defaults to transport",
    new AIProviderError("gemini", "boom").kind === "transport");
  check("a schema mismatch is content",
    new AIProviderError("gemini", "格式錯誤", "content").kind === "content");

  const providers = ["gemini", "openai-compatible", "anthropic"];
  for (const name of providers) {
    const src = readFileSync(join(__dirname, "..", "lib", "ai", "providers", `${name}.ts`), "utf8");
    check(`${name} reports a schema mismatch as content, not a connection failure`,
      /回應不符合[\s\S]{0,200}"content"/.test(src), name);
  }

  // The chain only backs off a provider it could not reach. Structural: the
  // failure is silent and expensive — a working provider disabled for the
  // rest of the sweep, and every symbol after it scoring with one dimension
  // fewer.
  const chain = readFileSync(join(__dirname, "..", "lib", "ai", "index.ts"), "utf8");
  check("the chain does not back off a provider that answered",
    /err\.kind === "transport"[\s\S]{0,120}recordFailure/.test(chain), "index.ts");

  // And the budget that caused the truncations in the first place.
  const news = readFileSync(join(__dirname, "..", "lib", "analysis", "news.ts"), "utf8");
  check("the news schema is given enough output budget to close its JSON",
    /maxTokens:\s*(1[2-9]\d\d|[2-9]\d\d\d)/.test(news), news.match(/maxTokens:\s*\d+/)?.[0]);
  const gemini = readFileSync(join(__dirname, "..", "lib", "ai", "providers", "gemini.ts"), "utf8");
  check("and a truncated gemini reply is retried with more of it",
    gemini.includes('finishReason === "MAX_TOKENS"'), "gemini.ts");
}

report("AI truncation + breaker");

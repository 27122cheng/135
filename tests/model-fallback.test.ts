import { check, report, stubFetch } from "./_harness";
import { __resetCacheForTests } from "@/lib/data-sources/cache";
import { __resetQuotaForTests } from "@/lib/data-sources/quota";
import { __resetModelMemoryForTests, isModelError } from "@/lib/ai/model-fallback";
import { completeAI, testAIProviders, textSchema } from "@/lib/ai";

/**
 * 「AI 供應商一直呼叫失敗」— and the keys were fine.
 *
 * Free-tier model ids die young: Google folds old Flash models, Groq
 * decommissions Llama versions with a 400 and a sentence, OpenRouter rotates
 * the `:free` suffix. Each provider was wired to exactly one id, so a retired
 * id killed its provider permanently. Pinned here: a dead model id walks down
 * the candidate list, the working id is remembered, and a quota error is
 * never confused with a model error — retrying a 429 against three names
 * spends the quota it is out of.
 */

const geminiOk = { candidates: [{ content: { parts: [{ text: "OK" }] } }] };
const S = textSchema("");

function reset() {
  __resetQuotaForTests();
  __resetCacheForTests();
  __resetModelMemoryForTests();
  for (const k of ["GEMINI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "AI_PROVIDER_ORDER"]) {
    delete process.env[k];
  }
}

async function main() {
  // ── the classifier ──────────────────────────────────────────────
  {
    check("404 is a model error", isModelError(404, "anything"));
    check("a decommission notice is a model error",
      isModelError(400, "model llama-3.1-70b-versatile has been decommissioned"));
    check("not-found wording is a model error", isModelError(400, "model not found"));
    check("a quota 429 is NOT a model error", !isModelError(429, "quota exceeded"));
    check("a bad-key 401 is NOT a model error", !isModelError(401, "invalid api key"));
    check("an unrelated 400 is NOT a model error", !isModelError(400, "content policy violation"));
  }

  // ── a retired id walks down the list ────────────────────────────
  {
    reset();
    process.env.GEMINI_API_KEY = "x";
    const seen = stubFetch((url) =>
      url.includes("gemini-2.5-flash")
        ? { status: 404, json: { error: { message: "models/gemini-2.5-flash is not found" } } }
        : url.includes("googleapis")
          ? { status: 200, json: geminiOk }
          : { status: 500, body: "no" },
    );
    const r = await completeAI("p", S, []);
    check("a retired default falls through to the next id", r?.provider === "gemini", r);
    check("both ids were tried", seen.filter((u) => u.includes("googleapis")).length === 2, seen);

    // The working id is remembered: the next call must not re-probe the dead one.
    __resetCacheForTests();
    const seen2 = stubFetch((url) =>
      url.includes("googleapis") ? { status: 200, json: geminiOk } : { status: 500, body: "no" },
    );
    await completeAI("p2", S, []);
    check("the working id is remembered across calls",
      seen2.length === 1 && !seen2[0].includes("gemini-2.5-flash"), seen2);
  }

  // ── quota errors do not burn the model list ─────────────────────
  {
    reset();
    process.env.GEMINI_API_KEY = "x";
    process.env.GROQ_API_KEY = "x";
    const seen = stubFetch((url) =>
      url.includes("googleapis")
        ? { status: 429, json: { error: { message: "quota exceeded" } } }
        : url.includes("groq")
          ? { status: 200, json: { choices: [{ message: { content: "OK" } }] } }
          : { status: 500, body: "no" },
    );
    const r = await completeAI("p", S, []);
    check("a 429 hops providers, not model ids", r?.provider === "groq", r);
    check("gemini was asked exactly once",
      seen.filter((u) => u.includes("googleapis")).length === 1, seen);
  }

  // ── every id dead names the cure ────────────────────────────────
  {
    reset();
    process.env.GROQ_API_KEY = "x";
    stubFetch((url) =>
      url.includes("groq")
        ? { status: 400, json: { error: { message: "model has been decommissioned" } } }
        : { status: 500, body: "no" },
    );
    const gaps: string[] = [];
    const r = await completeAI("p", S, gaps);
    check("all ids dead still returns null, never throws", r === null);
    check("and the gap names the override key",
      gaps.some((g) => g.includes("GROQ_MODEL")), gaps);
  }

  // ── the settings-page test reports verbatim errors ──────────────
  {
    reset();
    process.env.GEMINI_API_KEY = "x";
    stubFetch((url) =>
      url.includes("googleapis")
        ? { status: 401, json: { error: { message: "API key not valid" } } }
        : { status: 500, body: "no" },
    );
    const results = await testAIProviders();
    const gemini = results.find((r) => r.name === "gemini")!;
    check("a configured provider is tested live", gemini.configured && !gemini.ok, gemini);
    check("with the provider's own words", gemini.detail?.includes("API key not valid") === true,
      gemini.detail);
    const groq = results.find((r) => r.name === "groq")!;
    check("an unconfigured provider is labelled, not failed",
      !groq.configured && groq.detail === "未設定金鑰", groq);
  }

  report("model fallback");
}

void main();

import { check, report, stubFetch } from "./_harness";
import { __resetCacheForTests } from "@/lib/data-sources/cache";
import { __resetQuotaForTests } from "@/lib/data-sources/quota";
import {
  __resetModelMemoryForTests,
  isModelError,
  isPerModelQuotaError,
  retryAfterMs,
} from "@/lib/ai/model-fallback";
import { completeAI, testAIProviders, textSchema } from "@/lib/ai";
import { clearDiscoveryCache } from "@/lib/ai/model-discovery";

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
  // Discovery is cached per process for an hour; one case's catalogue must not
  // decide the next case's model list.
  clearDiscoveryCache();
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
    // The FIRST id is the one stubbed dead — the walk only proves anything
    // when the head of the list fails. (The alias leads the list now: a
    // retired versioned id was killing the whole provider while a
    // version-agnostic pointer sat behind it.)
    const seen = stubFetch((url) =>
      url.includes("gemini-flash-latest")
        ? { status: 404, json: { error: { message: "models/gemini-flash-latest is not found" } } }
        : url.includes("googleapis")
          ? { status: 200, json: geminiOk }
          : { status: 500, body: "no" },
    );
    const r = await completeAI("p", S, []);
    check("a retired default falls through to the next id", r?.provider === "gemini", r);
    check("both ids were tried",
      seen.filter((u) => u.includes(":generateContent")).length === 2, seen);
    // The catalogue lookup is a repair, not a preflight: it must not run while
    // a committed id still answers. Doing it up front cost a round trip on
    // every cold invocation, inside a 60-second function ceiling.
    check("and the catalogue was not consulted — a known id worked",
      !seen.some((u) => u.endsWith("/v1beta/models")), seen);

    // The working id is remembered: the next call must not re-probe the dead one.
    __resetCacheForTests();
    const seen2 = stubFetch((url) =>
      url.includes("googleapis") ? { status: 200, json: geminiOk } : { status: 500, body: "no" },
    );
    await completeAI("p2", S, []);
    check("the working id is remembered across calls",
      seen2.length === 1 && !seen2[0].includes("gemini-2.5-flash"), seen2);
  }

  // ── per-minute limits do not burn the model list ──────────────────
  //
  // Narrowed from "any 429": daily per-model quotas now hop ids (pinned
  // below via isPerModelQuotaError), because each model has its own daily
  // allowance. Per-minute limits are shared across models, so they still
  // abort straight to the next provider without probing siblings.
  {
    reset();
    process.env.GEMINI_API_KEY = "x";
    process.env.GROQ_API_KEY = "x";
    const seen = stubFetch((url) =>
      url.includes("googleapis")
        ? { status: 429, json: { error: { message: "Resource exhausted: requests per minute" } } }
        : url.includes("groq")
          ? { status: 200, json: { choices: [{ message: { content: "OK" } }] } }
          : { status: 500, body: "no" },
    );
    const r = await completeAI("p", S, []);
    check("a 429 hops providers, not model ids", r?.provider === "groq", r);
    // The generate call, once — a per-minute limit is provider-wide, so
    // walking model ids would only spend the quota it is already out of. The
    // catalogue lookup that precedes it is not a generate call.
    check("gemini was asked exactly once",
      seen.filter((u) => u.includes(":generateContent")).length === 1, seen);
  }

  // ── all known ids dead: ask the catalogue, then use it ──────────
  //
  // The failure this repairs, verbatim from the live site: Groq answered
  // "The model `llama-3.1-8b-instant` does not exist or you do not have
  // access to it" for every name the repo knew. No amount of guessing a newer
  // slug fixes an account whose catalogue moved; asking it does.
  {
    reset();
    process.env.GROQ_API_KEY = "x";
    const seen = stubFetch((url) => {
      if (url.endsWith("/v1/models")) {
        return { status: 200, json: { data: [{ id: "some-new-model-2027" }] } };
      }
      if (url.includes("chat/completions")) {
        // Only the discovered id works; every committed one is gone.
        return { status: 404, json: { error: { message: "does not exist" } } };
      }
      return { status: 500, body: "no" };
    });
    await completeAI("p", S, []);
    check("the catalogue is consulted once the known ids are exhausted",
      seen.some((u) => u.endsWith("/v1/models")), seen);
    check("and it is asked after them, not before",
      seen.findIndex((u) => u.endsWith("/v1/models")) > 0, seen);

    // And the discovered id is actually called.
    reset();
    process.env.GROQ_API_KEY = "x";
    const seen2 = stubFetch((url, init) => {
      if (url.endsWith("/v1/models")) {
        return { status: 200, json: { data: [{ id: "brand-new-id" }] } };
      }
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("brand-new-id")) {
        return { status: 200, json: { choices: [{ message: { content: "OK" } }] } };
      }
      return { status: 404, json: { error: { message: "does not exist" } } };
    });
    const r = await completeAI("p", S, []);
    check("a model only the catalogue knew about answers", r?.provider === "groq", r);
    check("without needing a redeploy or a GROQ_MODEL override",
      seen2.some((u) => u.includes("chat/completions")), seen2.length);
  }

  // ── the clock bounds the walk, not just each call ───────────────
  //
  // The per-request timeout bounded one call and nothing else. Four providers
  // × six model ids × 25 seconds is minutes of wall clock inside a function
  // Vercel kills at sixty — which is exactly how three symbols came back
  // "分析超過 60 秒，Vercel 中斷了這次請求" with every individual timeout
  // looking perfectly reasonable.
  {
    reset();
    process.env.GEMINI_API_KEY = "x";
    process.env.GROQ_API_KEY = "x";
    const seen = stubFetch(() => ({ status: 200, json: geminiOk }));
    const gaps: string[] = [];
    const r = await completeAI("p", S, gaps, { budgetMs: 1 });
    check("an exhausted budget stops the chain before any provider is called",
      seen.length === 0, seen);
    check("and returns null so the local rules take over", r === null);
    check("saying it was the time budget, not a provider failure",
      gaps.some((g) => g.includes("時間預算")), gaps);
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

  // ── per-model daily quotas hop to the next id ─────────────────────
  //
  // Both texts below are verbatim from live 429s. Daily allowances are
  // metered per model, so a sibling id has its own; per-minute limits are
  // shared, so hopping would spend what just ran out.
  {
    check("gemini's per-model daily quota is hoppable",
      isPerModelQuotaError(429,
        "You exceeded your current quota … Quota exceeded for metric: generate_content_free_tier_requests, limit: 20, model: gemini-3.6-flash"));
    check("groq's per-model TPD is hoppable",
      isPerModelQuotaError(429,
        "Rate limit reached for model `llama-3.3-70b-versatile` … on tokens per day (TPD): Limit 100000, Used 98443"));
    check("a per-minute limit is not",
      !isPerModelQuotaError(429, "Rate limit reached … tokens per minute (TPM)"));
    check("a bare 429 with no quota wording is not",
      !isPerModelQuotaError(429, "Too Many Requests"));
    check("only 429s qualify",
      !isPerModelQuotaError(400, "quota exceeded per day"));
  }

  // ── the wait the provider itself asked for ────────────────────────
  //
  // Groq's 429 states it: "Please try again in 19.98s". Throwing that away
  // cost the analysis its AI over a limit that clears inside one function
  // call — but a wait long enough to hold a serverless invocation open is
  // refused rather than obeyed.
  {
    check("a short stated wait is taken",
      retryAfterMs("Rate limit reached … Please try again in 19.98s") === 19980);
    check("milliseconds parse too",
      retryAfterMs("Please try again in 800ms") === 800);
    check("a long wait is refused",
      retryAfterMs("Please try again in 900s") === null);
    check("minutes are refused as too long",
      retryAfterMs("Please try again in 5m") === null);
    check("no stated wait means no wait", retryAfterMs("Too Many Requests") === null);
    check("the Retry-After header wins when present",
      retryAfterMs("Please try again in 900s", "12") === 12000);
    check("and an over-long header is still refused",
      retryAfterMs("whatever", "600") === null);
  }

  report("model fallback");
}

void main();

import { check, report, stubFetch } from "./_harness";
import { __resetQuotaForTests } from "@/lib/data-sources/quota";
import { aiProviderStatus, completeAI, jsonSchema, textSchema } from "@/lib/ai";
import { buildTradePlan, decideStance } from "@/lib/analysis/trade-plan";
import { MIN_ENTRY_GRADE, gradeAllowsEntry } from "@/lib/scoring";

/**
 * The provider chain and the one guarantee that must survive swapping vendors:
 * the model can never emit a price the code didn't compute.
 */

const geminiOk = { candidates: [{ content: { parts: [{ text: "GEMINI SAID THIS" }] } }] };
const groqOk = { choices: [{ message: { content: "GROQ SAID THIS" } }] };

function clearKeys() {
  for (const k of [
    "GEMINI_API_KEY",
    "GROQ_API_KEY",
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "AI_PROVIDER_ORDER",
  ]) {
    delete process.env[k];
  }
}

async function main() {
  const S = textSchema("");

  clearKeys();
  __resetQuotaForTests();
  const g1: string[] = [];
  check("no keys returns null", (await completeAI("p", S, g1)) === null);
  check("no keys explains why", g1.some((g) => g.includes("GEMINI_API_KEY")), g1);

  // A provider with no key is skipped, not counted as a failure.
  clearKeys();
  __resetQuotaForTests();
  process.env.GROQ_API_KEY = "x";
  let hit = stubFetch(() => ({ status: 200, json: groqOk }));
  const g2: string[] = [];
  const r2 = await completeAI("p", S, g2);
  check("unconfigured provider is skipped", r2?.provider === "groq", r2);
  check("skipping generates no gap", g2.length === 0, g2);
  check("only groq was contacted", hit.every((u) => u.includes("groq")), hit);

  // Default order puts Gemini first.
  clearKeys();
  __resetQuotaForTests();
  process.env.GEMINI_API_KEY = "x";
  process.env.GROQ_API_KEY = "x";
  hit = stubFetch((u) =>
    u.includes("googleapis") ? { status: 200, json: geminiOk } : { status: 200, json: groqOk },
  );
  const r3 = await completeAI("p", S, []);
  check("gemini is tried first", r3?.provider === "gemini", r3);
  check("groq untouched when gemini works", !hit.some((u) => u.includes("groq")), hit);

  // 429 (the free tier's usual answer) falls through.
  __resetQuotaForTests();
  hit = stubFetch((u) =>
    u.includes("googleapis")
      ? { status: 429, json: { error: { message: "quota exceeded" } } }
      : { status: 200, json: groqOk },
  );
  const r4 = await completeAI("p", S, []);
  check("429 falls through to the next provider", r4?.provider === "groq", r4);
  check("both were contacted", hit.some((u) => u.includes("googleapis")) && hit.some((u) => u.includes("groq")));

  // A blank reply is a failure, not an answer.
  __resetQuotaForTests();
  stubFetch((u) =>
    u.includes("googleapis")
      ? { status: 200, json: { candidates: [{ content: { parts: [{ text: "   " }] } }] } }
      : { status: 200, json: groqOk },
  );
  check("empty reply falls through", (await completeAI("p", S, []))?.provider === "groq");

  __resetQuotaForTests();
  stubFetch(() => ({ status: 500, json: { error: { message: "boom" } } }));
  const g6: string[] = [];
  check("all providers down returns null", (await completeAI("p", S, g6)) === null);
  check("all-down names every failure", g6.some((g) => g.includes("gemini") && g.includes("groq")), g6);

  // Order override.
  clearKeys();
  __resetQuotaForTests();
  process.env.GEMINI_API_KEY = "x";
  process.env.GROQ_API_KEY = "x";
  process.env.AI_PROVIDER_ORDER = "groq,gemini";
  stubFetch((u) =>
    u.includes("googleapis") ? { status: 200, json: geminiOk } : { status: 200, json: groqOk },
  );
  check("AI_PROVIDER_ORDER is honoured", (await completeAI("p", S, []))?.provider === "groq");
  const status = aiProviderStatus();
  check("status reflects the order", status[0].name === "groq" && status[0].configured, status);

  // Schema rejection.
  const numeric = jsonSchema<{ score: number }>("t", "", (v) =>
    typeof v.score === "number" ? { score: v.score } : null,
  );
  check("json parsed from a markdown fence", numeric.parse('```json\n{"score":-0.3}\n```')?.score === -0.3);
  check("wrong type rejected", numeric.parse('{"score":"high"}') === null);
  check("prose rejected", numeric.parse("I think it is bullish") === null);

  // ── The invariant ────────────────────────────────────────────────
  clearKeys();
  __resetQuotaForTests();
  process.env.GEMINI_API_KEY = "x";
  const planInput = {
    symbol: "XAUUSD",
    direction: "long" as const,
    grade: "A" as const,
    bias_score: 9,
    entry_structure_score: 4,
    total_score: 13,
    bias_items: [],
    entryCandidates: [{ price: 2000, label: "現價" }],
    slCandidates: [{ price: 1980, label: "前低下方" }],
    tpCandidates: [{ price: 2050, label: "前高" }],
    narrative: "n",
    knownGaps: [],
    gradeForcesWait: false,
  };
  const reply = (obj: unknown) => ({
    status: 200,
    json: { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] },
  });

  stubFetch(() => reply({ stance: "enter", entry_index: 0, sl_index: 0, tp_index: 0, summary: "s" }));
  const p1 = await buildTradePlan(planInput, []);
  check(
    "valid indices resolve to the real structure prices",
    p1.entry === 2000 && p1.stop_loss === 1980 && p1.take_profit === 2050,
    p1,
  );
  check("risk_reward is derived, not taken from the model", p1.risk_reward === 2.5, p1.risk_reward);

  __resetQuotaForTests();
  stubFetch(() => reply({ stance: "enter", entry_index: 99, sl_index: 0, tp_index: 0, summary: "s" }));
  const gp2: string[] = [];
  const p2 = await buildTradePlan(planInput, gp2);
  check("out-of-range index is refused", p2.decided_by === "fallback", p2.decided_by);
  check("the refusal is recorded", gp2.some((g) => g.includes("編號無效")), gp2);

  __resetQuotaForTests();
  // A model trying to smuggle in its own price: there is no field for it.
  stubFetch(() =>
    reply({ stance: "enter", entry: 1234.5, entry_index: "0", sl_index: 0, tp_index: 0, summary: "s" }),
  );
  const p3 = await buildTradePlan(planInput, []);
  check("a raw price in the reply is ignored", p3.entry !== 1234.5, p3.entry);
  check("a string index is refused", p3.decided_by === "fallback", p3.decided_by);

  __resetQuotaForTests();
  stubFetch(() => reply({ stance: "enter", entry_index: 0, sl_index: 0, tp_index: 0, summary: "s" }));
  const gp4: string[] = [];
  const p4 = await buildTradePlan(
    { ...planInput, grade: "no-trade" as const, gradeForcesWait: true },
    gp4,
  );
  check("a no-trade grade can never become an entry", p4.stance === "wait", p4.stance);
  // The model isn't even asked any more, so there is no override to record —
  // the wait is the scoring rules' own decision and says so.
  check("the reason names the grade rule", p4.summary.includes("未達可進場門檻"), p4.summary);
  check("and it is marked as rule-decided, not AI", p4.decided_by === "fallback", p4.decided_by);

  // ── stance is deterministic ──────────────────────────────────────
  //
  // The bug this pins: the AI used to return `stance`, so identical inputs
  // could produce 進場 on one run and 觀望 on the next. The board showed a full
  // set of levels for SPX500 while the detail page, built a minute later, said
  // 觀望. Both were real; neither was reproducible.
  __resetQuotaForTests();
  // A reply that begs to enter. It must not be able to.
  stubFetch(() => reply({ entry_index: 0, sl_index: 0, tp_index: 0, summary: "enter now" }));
  const cGrade = await buildTradePlan(
    { ...planInput, grade: "C" as const, bias_score: 3, entry_structure_score: 1, total_score: 4 },
    [],
  );
  check("a C grade waits regardless of what the model wants", cGrade.stance === "wait", cGrade);
  check("and names the floor", cGrade.summary.includes(MIN_ENTRY_GRADE), cGrade.summary);
  check("B is the floor", MIN_ENTRY_GRADE === "B");
  check("C is below it", !gradeAllowsEntry("C"));
  check("B is allowed", gradeAllowsEntry("B"));
  check("A+ is allowed", gradeAllowsEntry("A+"));
  check("no-trade is never allowed", !gradeAllowsEntry("no-trade"));

  // Same input, ten times: the decision cannot vary.
  const verdicts = new Set(
    Array.from({ length: 10 }, () => decideStance({ ...planInput, grade: "A" as const }).stance),
  );
  check("the same input always yields the same stance", verdicts.size === 1, [...verdicts]);

  check(
    "no usable structures waits without asking",
    decideStance({ ...planInput, slCandidates: [] }).stance === "wait",
  );

  // Every listed combination loses on geometry: risk 20, reward 5.
  check(
    "a menu where no combination clears 1:1 waits",
    decideStance({
      ...planInput,
      tpCandidates: [{ price: 2005, label: "近前高" }],
    }).stance === "wait",
  );
  // But a workable pair anywhere in the menu is enough — refusing on the first
  // triple alone would stand aside from a trade the rules permit.
  check(
    "one workable combination is enough",
    decideStance({
      ...planInput,
      tpCandidates: [{ price: 2005, label: "近前高" }, { price: 2050, label: "前高" }],
    }).stance === "enter",
  );

  // The AI path must enforce the same R:R floor the fallback does. It didn't:
  // the model could hand back a trade risking more than it stood to make.
  __resetQuotaForTests();
  stubFetch(() => reply({ entry_index: 0, sl_index: 0, tp_index: 1, summary: "s" }));
  const gpRr: string[] = [];
  const badRr = await buildTradePlan(
    { ...planInput, tpCandidates: [{ price: 2050, label: "前高" }, { price: 2005, label: "近前高" }] },
    gpRr,
  );
  check("a sub-1:1 pick from the model is refused", badRr.decided_by === "fallback", badRr);
  check("and the refusal says why", gpRr.some((g) => g.includes("風險報酬比")), gpRr);

  report("ai providers");
}

void main();

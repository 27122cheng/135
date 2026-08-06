import { check, report } from "./_harness";
import { classifyByRules, describeConsequence, type StopContext } from "@/lib/journal/stop-review";
import { computeSeverity } from "@/lib/journal/severity";
import { computeInterventions, DEFAULT_EFFECTS } from "@/lib/journal/interventions";
import { PREVENTABLE_TAGS, STOP_REASON_TAGS } from "@/types/journal";
import type { JournalEntry } from "@/types/journal";
import type { BiasItem, SignalRow } from "@/types/signal";

/**
 * 停損 → 審查 → 改變之後的交易模式.
 *
 * The intervention engine could always change how signals are built; what it
 * never had was reviewed losses to learn from, because those only arrived by
 * hand and nobody hand-writes a post-mortem for every stop-out. These pin the
 * classifier that now writes them automatically — and, at the end, that the
 * classification really does reach the next signal.
 */

function signal(over: Partial<SignalRow> = {}): SignalRow {
  return {
    id: "sig-1",
    created_at: "2026-08-06T00:00:00Z",
    symbol: "US30",
    direction: "long",
    grade: "A",
    generated_at: "2026-08-06T00:00:00Z",
    bias_items: [],
    data_gaps: [],
    trade_plan: { entry_reason: "等回測 D1 前低（強度 3，距現價 0.4%）" },
    ...over,
  } as unknown as SignalRow;
}

function bias(dimension: BiasItem["dimension"], direction: BiasItem["direction"], weight: 0 | 1 | 2): BiasItem {
  return { dimension, direction, weight, factor: "f", evidence: "e", source: "s" };
}

function ctx(over: Partial<StopContext> = {}): StopContext {
  return {
    signal: signal(),
    entry: 54150,
    stopLoss: 53971,
    takeProfit: 54744,
    exitPrice: 53971,
    bestPrice: null,
    eventDuringHold: false,
    ...over,
  };
}

// ── the specific stories are told before the generic one ──────────
{
  check("a release during the hold is an event hit",
    classifyByRules(ctx({ eventDuringHold: true })).tag === "S4");

  const macroOpposed = signal({ bias_items: [bias("基本面", "short", 2)] });
  check("a macro read pointing the other way is S7",
    classifyByRules(ctx({ signal: macroOpposed })).tag === "S7");
  check("and the note says which way it pointed",
    classifyByRules(ctx({ signal: macroOpposed })).note.includes("空"),
    classifyByRules(ctx({ signal: macroOpposed })).note);

  const cotOpposed = signal({ bias_items: [bias("籌碼面", "short", 2)] });
  check("positioning pointing the other way is S8",
    classifyByRules(ctx({ signal: cotOpposed })).tag === "S8");

  // Agreeing dimensions must not trigger either rule.
  const agreeing = signal({ bias_items: [bias("基本面", "long", 2), bias("籌碼面", "long", 2)] });
  check("dimensions that agree accuse nobody",
    !["S7", "S8"].includes(classifyByRules(ctx({ signal: agreeing })).tag));
}

// ── the excursion decides between a bad direction and a tight stop ─
{
  // Went a full R in your favour and still came back through the stop. The
  // direction was fine; the stop was inside the noise.
  const wentWell = ctx({ bestPrice: 54150 + 179 * 1.2 });
  check("a trade that paid 1R first is a stop-too-tight", classifyByRules(wentWell).tag === "S3",
    classifyByRules(wentWell));
  check("and the note quotes the excursion",
    classifyByRules(wentWell).note.includes("R"), classifyByRules(wentWell).note);

  // Never went anywhere, and it was a market entry — that is chasing.
  const chased = ctx({
    bestPrice: 54155,
    signal: signal({ trade_plan: { entry_reason: "現價進場（即時價位 54150）" } as never }),
  });
  check("a market entry that never moved is a bad entry", classifyByRules(chased).tag === "S2",
    classifyByRules(chased));

  // Never went anywhere, but the entry was a real pullback level. Nothing to
  // blame but the direction.
  const wrongWay = ctx({ bestPrice: 54155 });
  check("a pullback entry that never moved is a bad direction",
    classifyByRules(wrongWay).tag === "S1", classifyByRules(wrongWay));

  check("with no excursion recorded it still answers",
    classifyByRules(ctx()).tag === "S1");
  check("and says the excursion was unknown",
    classifyByRules(ctx()).note.includes("沒有記錄"), classifyByRules(ctx()).note);
}

// ── execution and discipline are never assigned from a price series ─
{
  // The system watches prices; it never sees a fill. Diagnosing slippage or
  // indiscipline from that would be inventing a fact about the trader.
  const everyTag = new Set(
    [
      classifyByRules(ctx({ eventDuringHold: true })).tag,
      classifyByRules(ctx({ bestPrice: 54400 })).tag,
      classifyByRules(ctx({ bestPrice: 54151 })).tag,
      classifyByRules(ctx()).tag,
      classifyByRules(ctx({ signal: signal({ bias_items: [bias("基本面", "short", 2)] }) })).tag,
      classifyByRules(ctx({ signal: signal({ bias_items: [bias("籌碼面", "short", 1)] }) })).tag,
    ],
  );
  check("no rule path reaches S5", !everyTag.has("S5"), [...everyTag]);
  check("no rule path reaches S6", !everyTag.has("S6"), [...everyTag]);
}

// ── every tag says what it will change ────────────────────────────
{
  for (const tag of STOP_REASON_TAGS) {
    check(`${tag} states its consequence`, describeConsequence(tag).length > 10);
    const preventable = describeConsequence(tag).startsWith("可事前預防");
    check(`${tag} labels preventability consistently with the table`,
      preventable === PREVENTABLE_TAGS[tag]);
  }
  check("S5 admits it cannot trigger anything",
    describeConsequence("S5").includes("不會自動觸發"));
}

// ── and the classification actually reaches the next signal ───────
//
// The point of the whole loop. Three S3 stop-outs must come back as a wider
// stop buffer on the next build, without anybody opening the review page.
{
  // Built the way the auto-logger builds it: each entry's severity is computed
  // against the history that existed when it was written. That matters — the
  // formula rewards repetition, so the third S3 in a row scores higher than the
  // first, which is exactly how a pattern becomes an intervention.
  const history: JournalEntry[] = [];
  // Seven, not three: severity only reaches the "repeat offender" tier after
  // three prior same-tag losses, and the trigger needs the *average* severity
  // over the window to clear 3. Interventions only ever tighten, so the bar to
  // start tightening is deliberately high — this pins that it is reachable.
  for (let i = 0; i < 7; i++) {
    const severity = computeSeverity({ tag: "S3", pnlPct: -2.5, history: [...history] }).severity;
    history.unshift({
      id: `j${i}`,
      signal_id: null,
      symbol: "US30",
      direction: "long",
      grade: "A",
      entry_price: 100,
      exit_price: 97.5,
      result: "loss",
      pnl_pct: -2.5,
      closed_at: `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      stop_reason_tag: "S3",
      severity,
      review_note: "[自動追蹤] 觸及停損",
      created_at: `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    });
  }
  check("repetition raises severity", (history[0].severity ?? 0) > (history.at(-1)!.severity ?? 0),
    history.map((h) => h.severity));

  const effects = computeInterventions(history);
  check("a run of S3 losses widens the stop buffer",
    effects.stopBufferAtrMultiple > DEFAULT_EFFECTS.stopBufferAtrMultiple,
    [effects.stopBufferAtrMultiple, DEFAULT_EFFECTS.stopBufferAtrMultiple]);
  // Interventions may only ever tighten. An auto-written journal must not be
  // able to loosen anything by accident.
  check("and nothing was loosened",
    effects.biasScoreThresholdBump >= DEFAULT_EFFECTS.biasScoreThresholdBump &&
      effects.entryZoneWidthFactor <= DEFAULT_EFFECTS.entryZoneWidthFactor);
}

report("stop review");

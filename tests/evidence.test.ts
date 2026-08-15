import { check, report } from "./_harness";
import { breadthOf, dedupeBiasItems } from "@/lib/analysis/evidence";
import { planConfidence } from "@/lib/analysis/confidence";
import { computeBiasScore } from "@/lib/scoring";
import { backtestPlanGeometry } from "@/lib/analysis/backtest";
import type { BiasDimension, BiasItem, TradeSignal } from "@/types/signal";
import type { Candle } from "@/lib/data-sources/ohlcv";

/**
 * 一個事實，一票 — and the two things that follow from taking it seriously.
 */

function item(over: Partial<BiasItem> & { dimension: BiasDimension }): BiasItem {
  return {
    factor: "f",
    direction: "long",
    weight: 1,
    evidence: "e",
    source: "s",
    ...over,
  };
}

// ── the double count that started this ────────────────────────────
//
// 基本面 and 資金流 were both reading the same VIX print, with the same
// thresholds (≥25 / ≤14), the same direction rule and the same weight. One
// number, two votes, on an A threshold of 6.
{
  const vixTwice = [
    item({ dimension: "基本面", key: "risk-vix-level", direction: "short", evidence: "VIX=27.4" }),
    item({ dimension: "資金流", key: "risk-vix-level", direction: "short", evidence: "VIX=27.4" }),
  ];

  check("counted twice it was worth 2", computeBiasScore("short", vixTwice) === 2);

  const { items, notes } = dedupeBiasItems(vixTwice);
  check("it collapses to one item", items.length === 1, items);
  check("and to one vote", computeBiasScore("short", items) === 1);
  check("the weight is the heaviest reading, not the sum", items[0].weight === 1);
  check("the merge is reported", notes.length === 1 && notes[0].includes("重複計入"), notes);
  check("and both dimensions are named",
    notes[0].includes("基本面") && notes[0].includes("資金流"), notes[0]);
  check("the surviving item says it was merged",
    items[0].factor.includes("同源讀數"), items[0].factor);
  check("and carries both evidences", items[0].evidence.includes("同源"), items[0].evidence);
}

// ── two readings of one quantity that disagree ────────────────────
{
  // The 5-day dollar trend against the 20-day one. Resolving that by list order
  // would be a coin toss dressed as a decision; it is genuine ambiguity.
  const conflicted = [
    item({ dimension: "基本面", key: "usd-dxy-trend", direction: "long", weight: 1 }),
    item({ dimension: "資金流", key: "usd-dxy-trend", direction: "short", weight: 1 }),
  ];
  const { items, notes } = dedupeBiasItems(conflicted);
  check("they merge to one item", items.length === 1);
  check("with no direction", items[0].direction === "neutral", items[0].direction);
  check("so it contributes nothing either way", computeBiasScore("long", items) === 0);
  check("and the conflict is stated", notes[0].includes("方向相反"), notes[0]);
}

// ── weights are not summed, they are taken ────────────────────────
{
  const uneven = [
    item({ dimension: "基本面", key: "k", direction: "long", weight: 2 }),
    item({ dimension: "資金流", key: "k", direction: "long", weight: 1 }),
  ];
  const { items } = dedupeBiasItems(uneven);
  check("the heavier reading carries the merged item", items[0].weight === 2, items[0].weight);
  check("agreeing with yourself is not corroboration",
    computeBiasScore("long", items) === 2);
}

// ── distinct facts are left alone ─────────────────────────────────
{
  // DXY and the real rate are highly correlated and both still vote. Silently
  // merging them would need a covariance estimate this system cannot justify.
  const distinct = [
    item({ dimension: "基本面", key: "usd-dxy-trend" }),
    item({ dimension: "基本面", key: "real-rate" }),
    item({ dimension: "技術面", key: "tech-ema" }),
  ];
  const { items, notes } = dedupeBiasItems(distinct);
  check("three different measurements stay three", items.length === 3);
  check("and nothing is reported", notes.length === 0);

  // An item with no key can only ever merge with an identical item, never with
  // a different measurement.
  const unkeyed = [
    item({ dimension: "技術面", factor: "A" }),
    item({ dimension: "技術面", factor: "B" }),
  ];
  check("unkeyed items are not merged by dimension alone",
    dedupeBiasItems(unkeyed).items.length === 2);
}

// ── breadth: how many places the evidence came from ───────────────
{
  const concentrated = [
    item({ dimension: "技術面", key: "a", weight: 2 }),
    item({ dimension: "技術面", key: "b", weight: 2 }),
    item({ dimension: "技術面", key: "c", weight: 2 }),
  ];
  const broad = [
    item({ dimension: "技術面", key: "a", weight: 2 }),
    item({ dimension: "基本面", key: "b", weight: 2 }),
    item({ dimension: "新聞面", key: "c", weight: 2 }),
  ];
  check("both are worth 6 to the grade",
    computeBiasScore("long", concentrated) === 6 && computeBiasScore("long", broad) === 6);

  check("but one dimension agrees in the first", breadthOf("long", concentrated).agreeing.length === 1);
  check("and three in the second", breadthOf("long", broad).agreeing.length === 3);

  const opposed = [...broad, item({ dimension: "籌碼面", key: "d", direction: "short", weight: 2 })];
  const b = breadthOf("long", opposed);
  check("a dimension pointing the other way is counted as opposing",
    b.opposing.length === 1 && b.opposing[0] === "籌碼面", b);
  // A dimension whose items cancel is neither support nor dissent.
  const cancelling = [
    item({ dimension: "資金流", key: "x", direction: "long", weight: 1 }),
    item({ dimension: "資金流", key: "y", direction: "short", weight: 1 }),
  ];
  check("a dimension that cancels itself is silent",
    breadthOf("long", cancelling).silent.includes("資金流"));
}

// ── breadth reaches the confidence score, not the grade ───────────
{
  function signal(items: BiasItem[]): TradeSignal {
    return {
      symbol: "XAUUSD",
      direction: "long",
      grade: "A",
      bias_items: items,
      data_gaps: [],
      plan_backtest: null,
      trade_plan: { decided_by: "ai", risk_reward: 2 },
      entry_zone: { low: 100, high: 100, reason: "r" },
      stop_loss: { price: 90, structure: "s", reason: "r", invalidation: "i" },
      take_profits: [],
      path_obstacles: [],
    } as unknown as TradeSignal;
  }

  const concentrated = planConfidence(
    signal([
      item({ dimension: "技術面", key: "a", weight: 2 }),
      item({ dimension: "技術面", key: "b", weight: 2 }),
    ]),
  );
  const broad = planConfidence(
    signal([
      item({ dimension: "技術面", key: "a", weight: 2 }),
      item({ dimension: "基本面", key: "b", weight: 2 }),
      item({ dimension: "新聞面", key: "c", weight: 2 }),
    ]),
  );
  check("a broad case is more confident than a concentrated one of the same size",
    broad.score > concentrated.score, [broad.score, concentrated.score]);
  check("and the reason is named", broad.factors.some((f) => f.includes("面向同向")),
    broad.factors);

  const contested = planConfidence(
    signal([
      item({ dimension: "技術面", key: "a", weight: 2 }),
      item({ dimension: "基本面", key: "b", weight: 2 }),
      item({ dimension: "籌碼面", key: "c", direction: "short", weight: 2 }),
    ]),
  );
  check("a dimension arguing the other way costs confidence",
    contested.score < broad.score, [contested.score, broad.score]);
  check("and is named", contested.factors.some((f) => f.includes("反向")), contested.factors);
}

// ── the backtest is conditioned on the regime ─────────────────────
{
  // A market that trends up for 200 bars then down for 200. A long plan's
  // sample should come from the up half, not from all of it.
  const candles: Candle[] = [];
  for (let i = 0; i < 400; i++) {
    const p = i < 200 ? 100 + i * 0.5 : 200 - (i - 200) * 0.5;
    candles.push({
      time: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(),
      open: p,
      high: p + 1,
      low: p - 1,
      close: p,
      volume: 1000,
    });
  }

  const long = backtestPlanGeometry("long", 150, 147, 156, candles);
  check("a backtest is produced", long !== null);
  check("it is conditioned", long?.conditioned === true, long?.basis);
  check("and says how the sample was drawn",
    long?.basis?.includes("EMA50") === true, long?.basis);
  // The unconditional walk would have drawn half its sample from the downtrend,
  // where a long target essentially never fills.
  check("the conditioned hit rate beats an all-bars one",
    (long?.hitRate ?? 0) > 0.5, [long?.hitRate, long?.resolved]);

  // Too few matching bars must fall back rather than answer from noise.
  const short = candles.slice(0, 120);
  const thin = backtestPlanGeometry("short", 150, 153, 144, short);
  check("a thin conditioned sample falls back to all bars",
    thin === null || thin.conditioned === false, thin?.basis);
  if (thin) {
    check("and says why it fell back", thin.basis?.includes("不足") === true, thin.basis);
  }
}

report("evidence");

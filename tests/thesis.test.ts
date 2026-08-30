import { check, report } from "./_harness";
import { buildThesis, classifyRegime, playbookFor, ER_RANGING, ER_TRENDING } from "@/lib/analysis/thesis";
import { summariseRegime } from "@/lib/analysis/regime-summary";
import { regimeAdjustedProfile, DAY_PROFILE } from "@/lib/analysis/trade-plan";
import type { BiasItem } from "@/types/signal";

/**
 * 論點層 — regime, playbook, conditional weighting, invalidations, reasoning.
 *
 * The four things the operator named as missing from a weighted-sum scorer:
 * one playbook applied to every market, six dimensions that only ever add,
 * no written statement of what would prove the call wrong, and conclusions
 * with no visible reasoning. Each is pinned here on the behaviour, not on
 * the wording.
 */

function item(over: Partial<BiasItem> = {}): BiasItem {
  return {
    dimension: "技術面",
    factor: "f",
    direction: "long",
    weight: 1,
    evidence: "e",
    ...over,
  } as BiasItem;
}

/** The factor texts summariseRegime matches on — regime input is real. */
const trendingItems: BiasItem[] = [
  item({ factor: "D1 趨勢效率比 ER(20)=0.52 —— 趨勢行進中", direction: "neutral", weight: 0 }),
  item({ factor: "D1 結構：成熟趨勢（連兩段同向）", direction: "long", weight: 2 }),
  item({ factor: "W1 週線偏多", direction: "long", weight: 1 }),
];
const rangingItems: BiasItem[] = [
  item({ factor: "D1 趨勢效率比 ER(20)=0.09 —— 盤整（趨勢票已降權）", direction: "neutral", weight: 0 }),
  item({ factor: "D1 結構：單段趨勢（僅最近一段）", direction: "long", weight: 1 }),
];

// ── 行情性質：一套打法不再用到底 ──────────────────────────────────
{
  check("a high efficiency ratio with a structural side is a trend",
    classifyRegime(summariseRegime(trendingItems)) === "trending");
  check("a low one is a range",
    classifyRegime(summariseRegime(rangingItems)) === "ranging");
  check("in between is the transitional band", classifyRegime(summariseRegime([
    item({ factor: "D1 趨勢效率比 ER(20)=0.25 —— 過渡帶", direction: "neutral", weight: 0 }),
    item({ factor: "D1 結構：單段趨勢（僅最近一段）", direction: "long", weight: 1 }),
  ])) === "transitional");
  check("no efficiency reading at all is unknown, not a guess",
    classifyRegime(summariseRegime([])) === "unknown");
  // The thresholds must be the ones technical.ts already prints, or the card
  // shows a regime label that contradicts its own ER factor text.
  check("the thresholds match the analyzer's own", ER_RANGING === 0.18 && ER_TRENDING === 0.35);

  const withTrend = playbookFor({ direction: "long", directionTie: false, biasItems: trendingItems });
  check("a trend traded with the trend gets the pullback playbook",
    withTrend.entryStyle === "pullback" && !withTrend.fightsRegime, withTrend);
  check("and targets may reach further, because a trend has no ceiling",
    withTrend.maxTargetAtr === 5, withTrend.maxTargetAtr);

  const against = playbookFor({ direction: "short", directionTie: false, biasItems: trendingItems });
  check("a trend traded against it is flagged as fighting the regime",
    against.fightsRegime && against.fightNote !== null, against);
  check("and its targets are pulled back in", against.maxTargetAtr === 2, against.maxTargetAtr);

  const range = playbookFor({ direction: "long", directionTie: false, biasItems: rangingItems });
  check("a range gets the fade playbook", range.entryStyle === "fade", range);
  check("with targets bounded by the range itself", range.maxTargetAtr === 2, range.maxTargetAtr);
  check("and says the size should be smaller", range.sizeNote !== null);

  // The playbook is only real if it changes what the geometry search accepts.
  check("the playbook's reach actually reaches the profile",
    regimeAdjustedProfile(DAY_PROFILE, 5).maxTargetAtr === 5 &&
      regimeAdjustedProfile(DAY_PROFILE, 2).maxTargetAtr === DAY_PROFILE.maxTargetAtr,
    regimeAdjustedProfile(DAY_PROFILE, 5));
  check("an absent reach leaves the profile untouched",
    regimeAdjustedProfile(DAY_PROFILE, undefined) === DAY_PROFILE);
  check("the veto lines are never touched by the reach adjustment",
    regimeAdjustedProfile(DAY_PROFILE, 5).minHitRate === DAY_PROFILE.minHitRate &&
      regimeAdjustedProfile(DAY_PROFILE, 5).minExpectancyR === DAY_PROFILE.minExpectancyR);
}

// ── 面向互相制約：不再只是相加 ────────────────────────────────────
{
  // A rate differential pointing against the daily tape is discounted: on a
  // daily horizon it is usually already in the price. Note the dimension —
  // the analyzer emits rate spreads *inside* 基本面 with the spread's label
  // as the factor, so a rule keyed on a 「利差」 dimension would never fire.
  // The first cut of this function had exactly that bug; this pins it.
  const t = buildThesis({
    direction: "long",
    directionTie: false,
    biasItems: [
      ...trendingItems,
      item({ dimension: "基本面", factor: "2Y 德美利差", direction: "short", weight: 2 }),
    ],
  });
  const spread = t.conditional.find((c) => /利差/.test(c.factor))!;
  check("a rate spread against the daily trend is halved",
    spread.multiplier === 0.5, spread);
  check("and the discount states its market reason, not just a number",
    spread.why.includes("已反映在價格上"), spread.why);

  // Lagging positioning data in a fresh trend — the dimension most reliably
  // on the wrong side at exactly the turns that matter.
  const cot = buildThesis({
    direction: "long",
    directionTie: false,
    biasItems: [...trendingItems, item({ dimension: "籌碼面", factor: "COT 淨多下降", direction: "short", weight: 2 })],
  }).conditional.find((c) => c.dimension === "籌碼面")!;
  check("lagging positioning is discounted inside a trend", cot.multiplier === 0.5, cot);
  check("and says it is a different mechanism from the aggregate cap",
    cot.why.includes("總量天花板"), cot.why);

  // News decays without a scheduled catalyst, and matters more with one.
  const quiet = buildThesis({
    direction: "long", directionTie: false,
    biasItems: [...trendingItems, item({ dimension: "新聞面", factor: "情緒偏多", weight: 1 })],
  }).conditional.find((c) => c.dimension === "新聞面")!;
  const loud = buildThesis({
    direction: "long", directionTie: false, eventMinutesAway: 90, eventLabel: "NFP",
    biasItems: [...trendingItems, item({ dimension: "新聞面", factor: "情緒偏多", weight: 1 })],
  }).conditional.find((c) => c.dimension === "新聞面")!;
  check("news is discounted outside an event window", quiet.multiplier < 1, quiet);
  check("and counts for more inside one", loud.multiplier > quiet.multiplier, loud);

  // Subtract-only: a flattering context must not manufacture conviction.
  check("context that erodes the case costs conviction",
    buildThesis({
      direction: "long", directionTie: false,
      biasItems: [...trendingItems, item({ dimension: "籌碼面", direction: "long", weight: 2 })],
    }).convictionPenalty > 0);
  check("the penalty is never negative — flattering context adds nothing",
    buildThesis({ direction: "long", directionTie: false, biasItems: trendingItems })
      .convictionPenalty >= 0);
}

// ── 反證條件：進場前先寫下來 ──────────────────────────────────────
{
  const t = buildThesis({
    direction: "long",
    directionTie: false,
    biasItems: trendingItems,
    plan: { entry: 100, stopLoss: 97, takeProfit: 108 },
    eventMinutesAway: 45,
    eventLabel: "FOMC 利率決策",
  });
  const kinds = new Set(t.invalidations.map((i) => i.kind));
  check("the plan's own stop becomes a written invalidation", kinds.has("price"), t.invalidations);
  check("so does the structural flip the monitor acts on", kinds.has("structure"));
  check("so does the regime that chose the playbook", kinds.has("regime"));
  check("and a scheduled release inside the window", kinds.has("event"));
  check("each one says what its happening would PROVE, not just that it happened",
    t.invalidations.every((i) => i.meaning.length > 10), t.invalidations);
  check("the price trigger quotes the plan's real level",
    t.invalidations.some((i) => i.kind === "price" && i.trigger.includes("97")), t.invalidations);

  // A trend and a range are invalidated by opposite moves in the same number.
  const trendInv = t.invalidations.find((i) => i.kind === "regime")!;
  check("a trend is invalidated by the efficiency ratio COLLAPSING",
    trendInv.trigger.includes("跌破"), trendInv);
  const rangeInv = buildThesis({
    direction: "long", directionTie: false, biasItems: rangingItems,
  }).invalidations.find((i) => i.kind === "regime")!;
  check("a range is invalidated by it BREAKING OUT",
    rangeInv.trigger.includes("升破"), rangeInv);
}

// ── 推理過程：結論要能被跟著走一遍 ────────────────────────────────
{
  const t = buildThesis({
    direction: "long",
    directionTie: false,
    biasItems: trendingItems,
    plan: { entry: 100, stopLoss: 97, takeProfit: 108 },
    entryStructures: [
      { price: 98, role: "support", type: "前低", timeframe: "D1", strength: 2, distance_pct: -2 } as never,
    ],
  });
  const steps = t.reasoning.map((s) => s.step);
  check("the chain runs regime → playbook → direction → entry, in that order",
    steps[0].includes("行情性質") && steps[1].includes("打法") &&
      steps[2].includes("方向") && steps[3].includes("進場"),
    steps);
  check("every step carries its own evidence, never a bare claim",
    t.reasoning.every((s) => s.evidence.length > 0 && s.claim.length > 0), t.reasoning);
  check("the regime step quotes the actual efficiency ratio",
    t.reasoning[0].evidence.some((e) => e.includes("0.52")), t.reasoning[0]);
  check("the entry step quotes the real levels",
    t.reasoning[3].claim.includes("100") && t.reasoning[3].claim.includes("97"), t.reasoning[3]);

  // A tie is stated as an absence of view, not dressed up as a direction.
  const tie = buildThesis({ direction: "long", directionTie: true, biasItems: rangingItems });
  check("a directional tie says there is no direction",
    tie.reasoning.some((s) => s.claim.includes("沒有方向")), tie.reasoning);
}

// ── 防禦性：舊資料列不能讓卡片崩掉 ────────────────────────────────
{
  const junk = buildThesis({
    direction: "long",
    directionTie: false,
    biasItems: [null, undefined, { factor: 1 }, { dimension: "技術面" }] as never,
  });
  check("unrecognisable rows produce a smaller thesis, never a throw",
    junk.playbook.regime === "unknown" && junk.reasoning.length > 0, junk.playbook);
  check("and the missing regime is stated rather than guessed",
    junk.reasoning[0].evidence.join("").includes("缺少"), junk.reasoning[0]);
}

report("分析論點");

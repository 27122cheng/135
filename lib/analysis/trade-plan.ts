import { completeAI, jsonSchema, type AiUnavailable } from "@/lib/ai";
import type { BiasItem, Grade, TradePlan, TradeSignal } from "@/types/signal";
import { MIN_ENTRY_GRADE, gradeAllowsEntry } from "@/lib/scoring";
import { backtestPlanGeometry } from "./backtest";
import { isNearEntry } from "./proximity";
import type { Candle } from "../data-sources/ohlcv";
import type { PlanBacktest } from "@/types/signal";

interface Candidate {
  price: number;
  label: string;
}

export interface TradePlanInput {
  symbol: string;
  direction: "long" | "short";
  grade: Grade;
  bias_score: number;
  entry_structure_score: number;
  total_score: number;
  bias_items: BiasItem[];
  entryCandidates: Candidate[];
  slCandidates: Candidate[];
  tpCandidates: Candidate[];
  narrative: string;
  /** data_gaps so far — the AI should weigh missing evidence when deciding. */
  knownGaps: string[];
  /**
   * True when the hard scoring rules already returned no-trade. The AI may
   * still explain and say what to wait for, but must not turn it into an entry.
   */
  gradeForcesWait: boolean;
  /**
   * The instrument's own history, used to rank candidate geometries by what has
   * actually happened rather than by which one has the prettiest ratio. Optional
   * so a caller without candles still gets a plan — it just gets the old rule
   * and is told so.
   */
  candles?: Candle[];
  /**
   * D1 ATR, for the sizing screens. Without it the ratio floor is the only
   * constraint, and a ratio cannot tell a stop inside the noise from a sane one.
   */
  atr?: number | null;
}

function round(n: number): number {
  return Math.round(n * 100000) / 100000;
}

function riskReward(
  direction: "long" | "short",
  entry: number,
  sl: number,
  tp: number,
): number | null {
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  if (risk <= 0) return null;
  // Sanity: the stop must sit on the losing side and the target on the winning side.
  const stopOk = direction === "long" ? sl < entry : sl > entry;
  const targetOk = direction === "long" ? tp > entry : tp < entry;
  if (!stopOk || !targetOk) return null;
  return Math.round((reward / risk) * 100) / 100;
}


/**
 * A trade that risks more than it stands to make isn't worth taking.
 * Named because two code paths enforce it and they must not drift.
 */
const MIN_RISK_REWARD = 1;

/** Prompt size caps — see buildPrompt for why each is where it is. */
const MAX_CANDIDATES = 6;
const MAX_BIAS_ITEMS = 8;
const MAX_NARRATIVE_CHARS = 300;

interface StanceVerdict {
  stance: "enter" | "wait";
  summary: string;
  waitFor: string | null;
}

/**
 * Whether to trade at all — decided by the scoring rules, never by the model.
 *
 * The AI used to return `stance`, which meant the same score could produce
 * 進場 on one run and 觀望 on the next: the board showed a full set of levels
 * for SPX500 while the detail page, built a minute later from identical
 * inputs, said 觀望. Both were "real"; neither was reproducible.
 *
 * Making the model deterministic is not on the menu. Taking the decision away
 * from it is. What the AI still does — choose which of the listed structures to
 * use, and write the reasons — is judgement over a fixed menu, and a different
 * choice there changes the levels, not whether you are in the market.
 *
 * Pure and synchronous, so the rule is testable without a model or a network.
 */
export function decideStance(input: TradePlanInput): StanceVerdict {
  if (input.gradeForcesWait || !gradeAllowsEntry(input.grade)) {
    return {
      stance: "wait",
      summary:
        `評等 ${input.grade}（方向分 ${input.bias_score}、結構分 ${input.entry_structure_score}、` +
        `總分 ${input.total_score}）未達可進場門檻 ${MIN_ENTRY_GRADE}，依計分規則觀望。`,
      waitFor: `等待評等升到 ${MIN_ENTRY_GRADE} 以上 —— 需要更多面向同向，或價格回測到更強的結構。`,
    };
  }

  if (
    input.entryCandidates.length === 0 ||
    input.slCandidates.length === 0 ||
    input.tpCandidates.length === 0
  ) {
    return {
      stance: "wait",
      summary: "沒有足夠的真實結構可以組成進場／停損／停利，依規則觀望。",
      waitFor: "等待價格接近有效的支撐／壓力結構。",
    };
  }

  // Every listed combination loses on geometry alone. Checking all of them
  // rather than the first triple: the AI is about to pick from this menu, and
  // refusing here on the default choice while a workable pair exists would
  // stand aside from a trade the rules actually permit.
  const anyWorkable = input.entryCandidates.some((entry) =>
    input.slCandidates.some((sl) =>
      input.tpCandidates.some((tp) => {
        const rr = riskReward(input.direction, entry.price, sl.price, tp.price);
        return rr !== null && rr >= MIN_RISK_REWARD;
      }),
    ),
  );
  if (!anyWorkable) {
    return {
      stance: "wait",
      summary: `現有結構的任何組合風險報酬比都低於 1:${MIN_RISK_REWARD}，賠率不划算，依規則觀望。`,
      waitFor: "等待價格回落到更好的進場位置，或等更遠的停利結構出現。",
    };
  }

  return { stance: "enter", summary: "", waitFor: null };
}

function waitPlan(
  summary: string,
  waitFor: string | null,
  decidedBy: "ai" | "fallback",
  fallbackReason: string | null = null,
): TradePlan {
  return {
    stance: "wait",
    entry: null,
    stop_loss: null,
    take_profit: null,
    entry_reason: "—",
    stop_loss_reason: "—",
    take_profit_reason: "—",
    risk_reward: null,
    confidence: "low",
    summary,
    add_ons: [],
    wait_for: waitFor,
    decided_by: decidedBy,
    fallback_reason: fallbackReason,
  };
}

/**
 * How many resolved samples a combination needs before its backtest is allowed
 * to rank it. Below this the hit rate is noise, and choosing a plan on noise is
 * worse than choosing it on arithmetic.
 */
const MIN_RESOLVED_FOR_RANKING = 30;

/** Expectancies within this of the best are treated as equal, so the tie-break decides. */
const EXPECTANCY_EPSILON = 0.05;

/**
 * A stop closer than this many ATR to the entry is not a stop, it is a coin
 * flip on noise.
 *
 * The live board produced US30 long at 53,289.30 with a stop at 53,160.77 —
 * 128 points, 0.24%, a fraction of a day's range on that index — against a
 * target 1,455 points away. 1:11.32 on paper, 15% hit rate in the backtest, and
 * the second number is a direct consequence of the first: the market crosses
 * that distance while doing nothing at all.
 *
 * Expectancy alone did not catch it, because 0.15 × 11.32 − 0.85 = +0.85R still
 * beats a sane 1:2. A positive expectation you get stopped out of six times in
 * seven is arithmetically fine and unusable — and the arithmetic is only fine
 * if the 15% is real, which a sample drawn from resolved cases at that
 * stop distance is not.
 */
const MIN_STOP_ATR = 0.6;

/**
 * A target beyond this many ATR is not a short-horizon trade.
 *
 * Was 4 — a multi-day swing at best. The standing request is 當日短線: trades
 * that resolve within roughly a session or two, at a higher hit rate, even at
 * the cost of payoff. Two D1 ATR is about what a market covers in one to two
 * active days; anything beyond it is a position, not a day trade, and its
 * backtest sample inside the 20-bar horizon is too thin to trust anyway.
 * A target 11R away with a stop inside the noise is a lottery ticket priced
 * as a plan.
 */
const MAX_TARGET_ATR = 2;

/**
 * The hit rate below which a plan is not followable, whatever its expectancy.
 *
 * This is a judgement, stated as one. An edge you cannot sit through is not an
 * edge you will capture: eight consecutive stop-outs is where a person stops
 * taking the signal, and a system that produces them is a system that gets
 * turned off. Combinations below this are only used when nothing clears it, and
 * the summary says so rather than hiding it.
 *
 * Raised from 0.3 with the day-trade tuning: nearer targets resolve more
 * often, so demanding they *hit* more often is affordable now — 45% at the
 * 1:1.22 breakeven means the geometry has to clear a real bar, not scrape by
 * on a long-shot payoff. (80–90% remains unbuyable at sane risk/reward:
 * breakevenRr(0.8) = 0.25 is risking four to make one.)
 */
const MIN_HIT_RATE = 0.45;

/**
 * The risk/reward a given hit rate needs just to break even.
 *
 * `hitRate × rr − (1 − hitRate) = 0` → `rr = (1 − hitRate) / hitRate`.
 *
 * Worth having as a function because the request that keeps coming back —
 * "keep the win rate around 80%" — is answerable with it, and the answer is not
 * the one it sounds like. At 80% the breakeven ratio is 0.25: you would be
 * risking four to make one. Every trade wins four times out of five and one
 * loss erases four wins, so the whole edge lives in never having two losses in
 * a row, which is not a property any of these markets has.
 *
 * A high hit rate is not something a system is tuned *to*; it is what falls out
 * of putting the target close. It is always purchasable — move the target in
 * far enough and you can have 95% — and it is never free.
 */
export function breakevenRr(hitRate: number): number {
  if (hitRate <= 0) return Infinity;
  if (hitRate >= 1) return 0;
  return Math.round(((1 - hitRate) / hitRate) * 100) / 100;
}

interface Combo {
  entry: Candidate;
  sl: Candidate;
  tp: Candidate;
  rr: number;
  backtest: PlanBacktest | null;
}

interface ComboScreen {
  combos: Combo[];
  /** Why combinations were dropped, for the summary. Empty when none were. */
  rejected: string[];
}

/**
 * Every combination that clears the risk/reward floor *and* is sized like a
 * trade rather than like a lottery ticket.
 *
 * The two ATR screens are what the risk/reward floor cannot express. A ratio is
 * scale-free by construction — 1:11 says nothing about whether the stop is
 * inside a day's noise or the target is a month away — and both of those are
 * exactly the questions that decide whether the plan is takeable.
 */
function viableCombos(input: TradePlanInput): ComboScreen {
  const out: Combo[] = [];
  const atr = input.atr && input.atr > 0 ? input.atr : null;
  let tooTight = 0;
  let tooFar = 0;
  let badRr = 0;

  for (const entry of input.entryCandidates) {
    for (const sl of input.slCandidates) {
      for (const tp of input.tpCandidates) {
        const rr = riskReward(input.direction, entry.price, sl.price, tp.price);
        if (rr === null || rr < MIN_RISK_REWARD) {
          badRr++;
          continue;
        }
        if (atr) {
          if (Math.abs(entry.price - sl.price) < atr * MIN_STOP_ATR) {
            tooTight++;
            continue;
          }
          if (Math.abs(tp.price - entry.price) > atr * MAX_TARGET_ATR) {
            tooFar++;
            continue;
          }
        }
        out.push({ entry, sl, tp, rr, backtest: null });
      }
    }
  }

  const rejected: string[] = [];
  if (tooTight > 0) rejected.push(`${tooTight} 組停損距離不足 ${MIN_STOP_ATR}×ATR（在雜訊內）`);
  if (tooFar > 0) rejected.push(`${tooFar} 組停利超過 ${MAX_TARGET_ATR}×ATR（20 根內走不到）`);
  if (badRr > 0) rejected.push(`${badRr} 組風報比低於 1:${MIN_RISK_REWARD}`);

  // Nothing survived the ATR screens but something cleared the ratio floor:
  // rather than refusing outright, fall back to the ratio-only set and say the
  // sizing screens found nothing. Standing aside is still available downstream
  // if the geometry is genuinely unusable.
  if (out.length === 0 && atr) {
    for (const entry of input.entryCandidates) {
      for (const sl of input.slCandidates) {
        for (const tp of input.tpCandidates) {
          const rr = riskReward(input.direction, entry.price, sl.price, tp.price);
          if (rr === null || rr < MIN_RISK_REWARD) continue;
          out.push({ entry, sl, tp, rr, backtest: null });
        }
      }
    }
    if (out.length > 0) rejected.push("沒有任何組合同時通過停損與停利的 ATR 篩選，改用未篩選的組合");
  }

  return { combos: out, rejected };
}

/**
 * Pick the plan's geometry.
 *
 * **Was: highest risk/reward.** That is the wrong objective, and the live board
 * showed exactly how it fails — NAS100 came back at 1:9.38 with a local hit
 * rate of 13% (30 wins in 230). Maximising the ratio always drifts to the
 * furthest target and the furthest entry, because distance mechanically
 * improves the ratio and nothing pushed back. The result is a plan that reads
 * beautifully and gets stopped out six times in seven.
 *
 * **Now: highest historical expectancy**, measured on the instrument's own
 * candles with the same backtest already shown on the card. Expectancy in R —
 * `hitRate × rr − (1 − hitRate)` — is the quantity that actually says whether a
 * geometry has been worth taking, and it prices the trade-off the ratio ignores:
 * a 1:9 that fills 13% of the time (+0.35R) loses to a 1:2 that fills half
 * (+0.5R).
 *
 * Two guards keep this honest:
 *
 *  - A combination is only *ranked* by its backtest once it has
 *    {@link MIN_RESOLVED_FOR_RANKING} resolved samples. Fewer than that and the
 *    hit rate is noise; picking on noise is worse than picking on arithmetic,
 *    so the old ratio rule is used instead and says so.
 *  - Among expectancies that are effectively tied, the higher hit rate wins.
 *    Two plans with the same edge are not the same plan to hold, and the one
 *    that resolves in your favour more often is the one a person can actually
 *    follow.
 */
function chooseGeometry(input: TradePlanInput): { combo: Combo; basis: string } | null {
  const { combos, rejected } = viableCombos(input);
  if (combos.length === 0) return null;
  const screen = rejected.length > 0 ? `（已排除：${rejected.join("、")}）` : "";

  // Highest ratio, nearest entry on a tie — the previous rule, kept as the
  // fallback for when there is not enough history to measure anything.
  const byRatio = combos.reduce((best, c) => (c.rr > best.rr ? c : best));

  const candles = input.candles;
  if (!candles || candles.length < 60) {
    return {
      combo: byRatio,
      basis: `歷史 K 棒不足以回測各組合，改以風險報酬比最佳者為準（本組 1:${byRatio.rr}）${screen}`,
    };
  }

  for (const c of combos) {
    c.backtest = backtestPlanGeometry(
      input.direction,
      c.entry.price,
      c.sl.price,
      c.tp.price,
      candles,
      c.rr,
    );
  }

  const rankable = combos.filter(
    (c) =>
      c.backtest !== null &&
      c.backtest.resolved >= MIN_RESOLVED_FOR_RANKING &&
      c.backtest.expectancyR !== null,
  );
  if (rankable.length === 0) {
    return {
      combo: byRatio,
      basis:
        `各組合的回測樣本都不足 ${MIN_RESOLVED_FOR_RANKING} 筆，不足以比較勝率，` +
        `改以風險報酬比最佳者為準（本組 1:${byRatio.rr}）${screen}`,
    };
  }

  // Followability first, then expectancy. Ranking on expectancy alone is how a
  // 1:11 at a 15% hit rate wins: the arithmetic is positive and the plan is
  // one nobody sits through. Combinations that clear the hit-rate floor are
  // ranked among themselves; only if none does are the rest considered, and
  // then the summary says the hit rate is low rather than quietly shipping it.
  const followable = rankable.filter((c) => (c.backtest!.hitRate ?? 0) >= MIN_HIT_RATE);
  const pool = followable.length > 0 ? followable : rankable;
  const lowHitRate = followable.length === 0;

  const bestExpectancy = Math.max(...pool.map((c) => c.backtest!.expectancyR!));
  const tied = pool.filter(
    (c) => c.backtest!.expectancyR! >= bestExpectancy - EXPECTANCY_EPSILON,
  );
  const chosen = tied.reduce((best, c) =>
    (c.backtest!.hitRate ?? 0) > (best.backtest!.hitRate ?? 0) ? c : best,
  );

  const bt = chosen.backtest!;
  const hitPct = Math.round((bt.hitRate ?? 0) * 100);
  const note =
    chosen === byRatio
      ? ""
      : `（賠率最高的一組是 1:${byRatio.rr}，但${lowHitRate ? "勝率或" : ""}本地回測期望值較低，未採用）`;
  const warn = lowHitRate
    ? `⚠ 沒有任何組合的回測勝率達到 ${Math.round(MIN_HIT_RATE * 100)}%，本組已是可選中最高，` +
      `期望值為正但會經常停損，部位要放小。` +
      `（以 ${hitPct}% 勝率計，只要風報比高於 1:${breakevenRr(bt.hitRate ?? 0)} 就是正期望值）`
    : "";
  return {
    combo: chosen,
    basis:
      `在 ${combos.length} 組真實結構組合中，先要求回測勝率 ≥ ${Math.round(MIN_HIT_RATE * 100)}%，` +
      `再取期望值最高者：${bt.resolved} 次中 ${bt.wins} 勝（勝率 ${hitPct}%），` +
      `每單位風險期望 ${bt.expectancyR}R，風報比 1:${chosen.rr}${note}${screen}${warn}`,
  };
}

/**
 * The best geometry available *without* recommending it — 參考價位.
 *
 * When the rules stand aside, the card still shows an entry zone, a stop and a
 * ladder of targets. Those were the raw computed levels: the mid of the entry
 * zone, the nearest protecting structure, the nearest obstacles ahead. Nothing
 * chose among them, so the reference prices were the one part of the card that
 * had not been through any of the work that makes the traded plan trustworthy —
 * no ATR sizing screen, no backtest, no expectancy, no hit rate. They were
 * levels, not an analysis, and they were being read as an analysis.
 *
 * This runs the identical selection the traded plan gets. Same screens, same
 * ranking, same numbers printed. The only difference is what it means: this is
 * "if the rules had let you take something, this is what it would have been",
 * and the card says so.
 */
export interface ReferenceGeometry {
  entry: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  entryReason: string;
  stopReason: string;
  targetReason: string;
  /** How it was chosen — the same sentence the traded plan carries. */
  basis: string;
  backtest: PlanBacktest | null;
}

export function selectReferenceGeometry(input: TradePlanInput): ReferenceGeometry | null {
  const picked = chooseGeometry(input);
  if (!picked) return null;
  const { entry, sl, tp, rr, backtest } = picked.combo;
  return {
    entry: round(entry.price),
    stopLoss: round(sl.price),
    takeProfit: round(tp.price),
    riskReward: rr,
    entryReason: entry.label,
    stopReason: sl.label,
    targetReason: tp.label,
    basis: picked.basis,
    backtest,
  };
}

/** Deterministic choice used when the AI is unavailable or returns anything invalid. */
function fallbackPlan(input: TradePlanInput, why: string | null): TradePlan {
  if (input.gradeForcesWait) {
    return waitPlan(
      `評等為 no-trade（方向分 ${input.bias_score}、結構分 ${input.entry_structure_score}、總分 ${input.total_score}），依硬性規則不進場。`,
      "等待評等回到 C 以上，或等價格回測到有效結構再重新評估。",
      "fallback",
      why,
    );
  }

  const picked = chooseGeometry(input);
  if (!picked) {
    // Either there were no candidates at all, or every combination lost on
    // geometry. decideStance already refuses the second case before the AI is
    // called, so reaching here means the lists themselves were empty.
    return waitPlan(
      input.entryCandidates.length === 0 ||
        input.slCandidates.length === 0 ||
        input.tpCandidates.length === 0
        ? "缺少可用的進場、停損或停利結構，無法組成計畫。"
        : `現有結構的任何組合風險報酬比都低於 1:${MIN_RISK_REWARD}，賠率不划算，建議觀望。`,
      "等待價格接近有效的支撐／壓力結構，或等更遠的停利結構出現。",
      "fallback",
      why,
    );
  }

  const { entry, sl, tp, rr } = picked.combo;
  return {
    stance: "enter",
    entry: round(entry.price),
    stop_loss: round(sl.price),
    take_profit: round(tp.price),
    entry_reason: entry.label,
    stop_loss_reason: sl.label,
    take_profit_reason: tp.label,
    risk_reward: rr,
    confidence: input.grade === "A+" || input.grade === "A" ? "medium" : "low",
    summary: `${why ?? "未使用 AI 判斷"}。${picked.basis}。`,
    add_ons: [],
    wait_for: null,
    decided_by: "fallback",
    fallback_reason: why,
  };
}

/**
 * Everything the model needs to pick levels, and nothing else.
 *
 * Rewritten after `stance` became deterministic. The old version spent a third
 * of its length arguing the case for standing aside — instructions for a
 * decision the model is no longer asked to make and has no field to answer in.
 * Dead prompt is not free: it is tokens on every call, on a free tier measured
 * in tokens per day.
 *
 * The trims are all "does this change which index gets picked":
 *  - bias items capped to the 8 heaviest; a weight-0 factor cannot tip a choice
 *  - the narrative truncated — it is prose *about* the factors already listed
 *  - gaps reduced to a count; which source failed doesn't change level choice,
 *    it changes confidence, and that is computed elsewhere
 *  - candidate lists capped at 6, which is more structures than any of these
 *    instruments produces near price anyway
 */
function buildPrompt(input: TradePlanInput): string {
  const list = (items: Candidate[]) =>
    items
      .slice(0, MAX_CANDIDATES)
      .map((c, i) => `  [${i}] ${c.price} — ${c.label}`)
      .join("\n");

  const heaviest = [...input.bias_items]
    .filter((b) => b.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_BIAS_ITEMS);

  return (
    `你是交易計畫決策助手。以下是 ${input.symbol} 的分析結果，訊號方向為 ${input.direction === "long" ? "做多" : "做空"}。\n` +
    `是否進場已由計分規則決定為「進場」，你的工作只是從清單中挑出最合適的三個價位並說明理由。\n\n` +
    `評等：${input.grade}（方向分 ${input.bias_score}、結構分 ${input.entry_structure_score}、總分 ${input.total_score}）\n\n` +
    `分析摘要：\n${input.narrative.slice(0, MAX_NARRATIVE_CHARS)}\n\n` +
    `主要因子（依權重前 ${MAX_BIAS_ITEMS}）：\n` +
    (heaviest.length > 0
      ? heaviest
          .map((b) => `  - [${b.dimension}/${b.direction}/權重${b.weight}] ${b.factor}`)
          .join("\n")
      : "  （無）") +
    (input.knownGaps.length > 0
      ? `\n\n注意：本次有 ${input.knownGaps.length} 項資料缺口，部分面向資訊不完整。`
      : "") +
    `\n\n可選的進場點：\n${list(input.entryCandidates)}\n` +
    `\n可選的停損點：\n${list(input.slCandidates)}\n` +
    `\n可選的停利點：\n${list(input.tpCandidates)}\n\n` +
    `嚴格規則：\n` +
    `1. 你只能從上面清單中「選編號」，絕對不可以自己提出任何新的價格數字。\n` +
    `2. 只准根據以上提供的資料推論，不准補充未提供的事實。`
  );
}

interface AiResponse {
  entry_index?: number;
  sl_index?: number;
  tp_index?: number;
  entry_reason?: string;
  sl_reason?: string;
  tp_reason?: string;
  summary?: string;
}

/**
 * Shape only — the index *values* are validated against the real candidate
 * lists in buildTradePlan, since the schema has no view of how many candidates
 * were offered. That check is what stops a model from naming a price we never
 * computed, so it must not be relaxed into this schema.
 */
const PLAN_SCHEMA = jsonSchema<AiResponse>(
  "trade-plan",
  `輸出嚴格的 JSON（不要 markdown code fence、不要其他文字）：\n` +
    `{"entry_index": number, "sl_index": number, "tp_index": number, ` +
    `"entry_reason": string, "sl_reason": string, "tp_reason": string, ` +
    `"summary": string}\n` +
    `三個 reason 各用一句繁體中文說明為何選這個點，wait_for 填空字串。\n` +
    `summary 一律用繁體中文 80 字內總結你的判斷邏輯與主要風險。`,
  // Validated on the indices, not on a stance field — this schema is only
  // reached once the rules have already decided to enter, so "should we trade"
  // is not a question the model is asked and not a field it can answer.
  (v) => (typeof v.entry_index === "number" ? (v as AiResponse) : null),
);

function validIndex(value: unknown, list: Candidate[]): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < list.length;
}

/**
 * Asks the AI to decide 進場 vs 觀望, and when entering, to pick the best
 * entry/SL/TP *by index* from candidates derived entirely from real structure.
 * Any invalid or out-of-range index — i.e. any attempt to answer with a price
 * we didn't offer — falls back to the deterministic plan rather than trusting
 * the model with a raw number.
 *
 * That guarantee is provider-independent by construction: the model never sees
 * a field where a price would be accepted, so swapping Gemini for Groq or
 * anything else cannot widen what it is able to say.
 */
export async function buildTradePlan(input: TradePlanInput, gaps: string[]): Promise<TradePlan> {
  // 進場與否是計分規則的決定，不是 AI 的。
  const verdict = decideStance(input);
  if (verdict.stance === "wait") {
    // No AI call at all on this path. It has nothing left to decide, and a
    // scan that stands aside shouldn't spend quota to be told so.
    return waitPlan(verdict.summary, verdict.waitFor, "fallback");
  }

  // Captured so the card can say *why* the AI was skipped. "未設定金鑰、額度
  // 用盡或呼叫失敗" is three guesses in one sentence, and it led with the one
  // that blamed the reader for a setting they had got right.
  let unavailable: AiUnavailable | null = null;
  const result = await completeAI(buildPrompt(input), PLAN_SCHEMA, gaps, {
    maxTokens: 900,
    onUnavailable: (why) => {
      unavailable = why;
    },
  });
  if (!result) {
    const why = (unavailable as AiUnavailable | null)?.message ?? "AI 未回應，改用預設規則";
    gaps.push("交易計畫改用預設規則判斷");
    return fallbackPlan(input, why);
  }
  const parsed = result.value;

  if (
    !validIndex(parsed.entry_index, input.entryCandidates) ||
    !validIndex(parsed.sl_index, input.slCandidates) ||
    !validIndex(parsed.tp_index, input.tpCandidates)
  ) {
    gaps.push("交易計畫 AI 回傳的價位編號無效（可能試圖給出清單外的價格），已改用預設規則");
    return fallbackPlan(input, "AI 回傳的價位編號無效，已改用預設規則");
  }

  const entry = input.entryCandidates[parsed.entry_index];
  const sl = input.slCandidates[parsed.sl_index];
  const tp = input.tpCandidates[parsed.tp_index];
  const rr = riskReward(input.direction, entry.price, sl.price, tp.price);
  if (rr === null) {
    gaps.push("AI 選出的停損／停利方向不合理（停損未在虧損側或停利未在獲利側），已改用預設規則");
    return fallbackPlan(input, "AI 選出的停損／停利方向不合理，已改用預設規則");
  }
  // The same floor the deterministic path applies. It was missing here, so the
  // AI could hand back a trade risking more than it stood to make while the
  // fallback would have refused the identical geometry.
  if (rr < MIN_RISK_REWARD) {
    gaps.push(`AI 選出的組合風險報酬比僅 1:${rr}，低於 1:${MIN_RISK_REWARD} 門檻，已改用預設規則`);
    return fallbackPlan(input, `AI 選出的組合風報比僅 1:${rr}，低於門檻，已改用預設規則`);
  }

  // Not taken from the model. `lib/analysis/confidence.ts` computes the number
  // the card actually shows, from the grade, the geometry, the gap count and
  // the local backtest; letting the plan carry a *different*, model-authored
  // word beside it would be two answers to one question.
  //
  // Approximated here from what this function can see — the full computation
  // needs the assembled signal, which does not exist yet at this point.
  const confidence: "high" | "medium" | "low" =
    input.grade === "A+" || input.grade === "A" ? "high" : input.grade === "B" ? "medium" : "low";

  return {
    stance: "enter",
    entry: round(entry.price),
    stop_loss: round(sl.price),
    take_profit: round(tp.price),
    entry_reason: parsed.entry_reason?.trim() || entry.label,
    stop_loss_reason: parsed.sl_reason?.trim() || sl.label,
    take_profit_reason: parsed.tp_reason?.trim() || tp.label,
    risk_reward: rr,
    confidence,
    summary: parsed.summary?.trim() || "（AI 未提供總結）",
    add_ons: [],
    wait_for: null,
    decided_by: "ai",
  };
}

/** Builds the candidate lists from an already-computed signal's real structures. */
export function collectCandidates(
  signal: Pick<
    TradeSignal,
    "direction" | "entry_zone" | "stop_loss" | "take_profits" | "entry_structures"
  >,
  atr: number | null,
): { entryCandidates: Candidate[]; slCandidates: Candidate[]; tpCandidates: Candidate[] } {
  const mid = (signal.entry_zone.low + signal.entry_zone.high) / 2;
  const entryCandidates: Candidate[] = [
    { price: round(mid), label: `現價進場（${signal.entry_zone.reason}）` },
  ];
  // Pullback entries: protecting structures the price could retrace into.
  for (const s of signal.entry_structures) {
    const isPullback =
      signal.direction === "long" ? s.role === "support" && s.price < mid : s.role === "resistance" && s.price > mid;
    if (isPullback && isNearEntry(s, mid, atr)) {
      entryCandidates.push({
        price: round(s.price),
        label: `等回測 ${s.timeframe} ${s.type}（強度 ${s.strength}，距現價 ${s.distance_pct}%）`,
      });
    }
  }

  const slCandidates: Candidate[] = [
    {
      price: signal.stop_loss.price,
      label: `${signal.stop_loss.structure}｜${signal.stop_loss.reason}`,
    },
  ];
  // A wider alternative: one ATR beyond the same structure, for noisier conditions.
  if (atr && atr > 0) {
    const wider =
      signal.direction === "long" ? signal.stop_loss.price - atr * 0.5 : signal.stop_loss.price + atr * 0.5;
    slCandidates.push({
      price: round(wider),
      label: `同結構外再放寬 0.5×ATR（較不易被雜訊掃到，風險較大）`,
    });
  }

  const tpCandidates: Candidate[] = signal.take_profits.map((tp) => ({
    price: tp.price,
    label: `${tp.structure}｜${tp.reason}`,
  }));

  return { entryCandidates, slCandidates, tpCandidates };
}

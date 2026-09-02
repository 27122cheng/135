import { forwardEvidenceDelta } from "./forward-evidence";
import type { PathObstacle, TradeSignal } from "@/types/signal";
import { isInformational } from "@/lib/data-gaps";
import { breadthOf } from "./evidence";

/**
 * 信心度 — computed, never asked for.
 *
 * The trade plan already carried a `confidence` field, and the AI filled it in.
 * That has the same defect `stance` had before it was taken away: the same
 * score could come back "high" on one run and "medium" on the next, and a
 * number nobody can reproduce is worse than no number, because it looks
 * precise.
 *
 * So this is arithmetic over things the engine has already decided — grade,
 * risk/reward, how many data sources failed, whether the AI was even available
 * to pick the levels, and what the local backtest of this geometry found.
 * Same inputs, same answer, always.
 *
 * ## What it is not
 *
 * Not a probability. Nothing here is calibrated against realised outcomes, and
 * presenting "68%" as a chance of winning would be inventing a claim the data
 * cannot support. It is a 0–100 ranking of how much of the system's own
 * evidence lines up behind this particular plan, and every component that moved
 * it is listed so the number can be argued with.
 */

/**
 * The score a plan must reach before it is called a trade.
 *
 * Below it the levels are still computed and still shown — the honest "this
 * nearly qualifies" picture — but the signal stands aside, and the number says
 * how far short it fell rather than leaving the reader to guess whether 觀望
 * meant "nothing here" or "so close".
 *
 * Was 90. At that height nothing traded: A+ starts at 80 and data gaps cost up
 * to 15, so a run with several sources down could not clear it however good the
 * setup was — and with the free AI tiers exhausted, *every* run had the −10
 * fallback penalty on top. A threshold that is never met is a disabled feature
 * wearing the costume of a strict one.
 *
 * Was 60 — B's own clean baseline — which made every ordinary degraded day
 * a veto: on the live free stack a scan routinely carries 4–6 source gaps
 * (GDELT dark, Finnhub circuit open, an AI tier exhausted), each costing
 * points, so a B that the grade table declares tradeable scored 45–55 and
 * stood aside on nearly every real run (EURUSD: confidence 52, blocked).
 * That is a second grading system, not a veto — and the operator's
 * architecture instruction is explicit: confidence is 附加條件, not the
 * arbiter.
 *
 * 45 aligns the veto with the vocabulary that already exists: `levelFor`
 * calls scores below 45「低」, and 低 is precisely the state this gate is
 * for — the evidence behind the signal genuinely did not arrive (the
 * live case: XAUUSD at confidence 5 with every quote source dead). Between
 * 45 and 70 the signal trades as「中」with its gaps listed on the card;
 * the analysis decides, the score annotates.
 *
 *  - A+ (80) / A (70) trade through bad data days
 *  - B (60) trades unless the run is genuinely degraded (score < 45)
 *  - C is refused upstream by the grade gate (`MIN_ENTRY_GRADE`); this veto
 *    no longer doubles that refusal — one gate, one job
 */
export const CONFIDENT_ENTRY_MIN = 45;

export type ConfidenceLevel = "high" | "medium" | "low";

export interface Confidence {
  /** 0–100. Comparable between signals; not a probability. */
  score: number;
  level: ConfidenceLevel;
  /** Every contribution, in the order applied. Shown to the reader verbatim. */
  factors: string[];
}

/**
 * The base each grade starts from, aligned to the entry bar on purpose.
 *
 * B was 55 against a bar of 60, which made the two gates contradict each
 * other: `MIN_ENTRY_GRADE` declares B tradeable, and then a *flawless* B —
 * no data gaps, AI available, geometry sound — scored 58 and stood aside
 * anyway. Measured, not theorised: A+ 83 / A 73 / B 58 on clean inputs. So
 * the grade table said one thing and the confidence gate quietly overruled
 * it every single time, which is a whole tier of the scoring system that
 * could never fire.
 *
 * B now starts exactly at the bar. That is the coherent reading of what the
 * two constants already claim: the grade decides whether a setup qualifies,
 * and confidence is a *veto for degraded conditions* — gaps, a spent AI
 * tier, a thin backtest — rather than a second grading system with its own
 * private opinion. A clean B trades; a B with three sources down does not.
 * Nothing above B moves, and no win-rate floor is touched: the 70% backtest
 * gate still has to pass before any of this is reached.
 */
const GRADE_BASE: Record<string, number> = {
  "A+": 80,
  A: 70,
  B: 60,
  C: 40,
  "no-trade": 20,
};

function clamp(n: number): number {
  return Math.max(5, Math.min(95, Math.round(n)));
}

/** Whether this score clears the bar for an actual entry. */
export function clearsEntryBar(score: number): boolean {
  return score >= CONFIDENT_ENTRY_MIN;
}

export function levelFor(score: number): ConfidenceLevel {
  if (score >= 70) return "high";
  if (score >= 45) return "medium";
  return "low";
}

export const LEVEL_LABEL: Record<ConfidenceLevel, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

/**
 * Confidence in the plan as a whole.
 *
 * The grade is the spine — it already encodes how much of the six-dimension
 * evidence agrees. Everything after it is an adjustment for things the grade
 * does not see: the geometry of this specific entry, how much of the input was
 * missing, and whether the levels were chosen or defaulted.
 */
export function planConfidence(signal: TradeSignal): Confidence {
  const factors: string[] = [];
  let score = GRADE_BASE[signal.grade] ?? 40;
  factors.push(`評等 ${signal.grade}（基準 ${score}）`);

  const rr = signal.trade_plan?.risk_reward ?? null;
  if (rr !== null) {
    // Rewards a genuinely better payoff, but capped: a 1:6 target is usually
    // far away, not free money, and the distance penalty belongs to the
    // per-target score rather than here.
    const bonus = Math.max(-10, Math.min(10, Math.round((rr - 1.5) * 6)));
    if (bonus !== 0) {
      score += bonus;
      factors.push(`風報比 1:${rr}（${bonus > 0 ? "+" : ""}${bonus}）`);
    }
  }

  // Breadth. The grade already knows *how much* evidence there is; it does not
  // know how many independent places it came from, and those are different
  // questions. Six points from 技術面 alone and six spread over three dimensions
  // grade identically — the second is a case, the first is one indicator read
  // four ways. Priced here rather than in the grade so a concentrated setup
  // still trades, it just doesn't claim the conviction of a broad one.
  const breadth = breadthOf(signal.direction, signal.bias_items ?? []);
  if (breadth.agreeing.length > 0 || breadth.opposing.length > 0) {
    // The first agreeing dimension is what the grade already paid for; only the
    // corroboration beyond it is new information.
    const corroboration = Math.min(6, Math.max(0, breadth.agreeing.length - 1) * 3);
    const dissent = Math.min(9, breadth.opposing.length * 3);
    const delta = corroboration - dissent;
    // Listed whenever anything disagrees, even when the arithmetic nets to
    // zero. "+3 for two dimensions agreeing, −3 for one arguing the other way"
    // is not the same fact as "nothing to report", and silently cancelling them
    // would hide the dissent behind its own offset.
    if (delta !== 0 || breadth.opposing.length > 0) {
      score += delta;
      factors.push(
        `${breadth.agreeing.length} 個面向同向` +
          (breadth.opposing.length > 0 ? `、${breadth.opposing.length} 個反向` : "") +
          `（${delta > 0 ? "+" : delta === 0 ? "±" : ""}${delta}）：` +
          `同向 ${breadth.agreeing.join("、") || "無"}` +
          (breadth.opposing.length > 0 ? `；反向 ${breadth.opposing.join("、")}` : ""),
      );
    }
  }

  // Data gaps, priced by whether the evidence is actually missing.
  //
  // This used to charge 3 points for every line in `data_gaps`, and that list
  // does not contain one kind of thing. "CFTC 合約代碼查無資料" means a whole
  // dimension is blank. "GDELT 429，改用 4 小時前的快取（stale）" means we have
  // the data and it is a few hours old — on a signal built from H4 candles that
  // is barely a defect at all. "所有 AI 供應商皆無法回應" is already charged
  // separately, five points below, as the fallback penalty.
  //
  // Charging all three the same is how NAS100 came back at 59 against a bar of
  // 60: a rate-limited news feed and an exhausted AI tier, both already
  // accounted for elsewhere, were being billed a second time at full price.
  // Missing evidence should cost; the same misfortune counted twice should not.
  // Behaviour notes ("本次不提供加倉點…", "已改用預設規則") describe a rule
  // firing as designed, not evidence that failed to arrive. Billing them −3 as
  // "missing" punished a signal for its own bookkeeping — a B-grade setup lost
  // confidence points *because* the add-on rule correctly declined to add on.
  const allGaps = (signal.data_gaps ?? []).filter((g) => !isInformational(g));
  // "非即時" covers the frozen-proxy last resort ("僅剩行情代理的舊資料可用…
  // 資料非即時") — data that was served, just old, which is the stale rate,
  // not the missing one.
  const stale = allGaps.filter(
    (g) => g.includes("快取") || g.includes("stale") || g.includes("非即時"),
  );
  const aiRelated = allGaps.filter((g) => g.includes("AI") && !stale.includes(g));
  const missing = allGaps.filter((g) => !stale.includes(g) && !aiRelated.includes(g));
  if (allGaps.length > 0) {
    // Missing evidence at full price; stale-but-served at a third of it,
    // because having the number late is not the same as not having it.
    const penalty = Math.min(15, missing.length * 3 + stale.length);
    if (penalty > 0) score -= penalty;
    factors.push(
      `${allGaps.length} 項資料缺口（-${penalty}）：` +
        `${missing.length} 項真的沒有` +
        (stale.length > 0 ? `、${stale.length} 項改用快取（有資料，只是不即時）` : "") +
        (aiRelated.length > 0 ? `、${aiRelated.length} 項 AI 相關（已在下方單獨計價）` : ""),
    );
  }

  if (signal.trade_plan?.decided_by === "fallback") {
    // Was −10, when the fallback simply took the first candidate of each list —
    // systematically the nearest target and therefore the worst payoff. It now
    // searches every combination and keeps the best risk/reward, so the penalty
    // is about the missing judgement (which structure suits *this* context) and
    // not about a choice nobody would defend.
    //
    // The size matters: with gaps costing up to 15, a −10 here meant even an A+
    // could not reach the 60 entry bar on a run where the free AI tier was
    // exhausted — which is every run once the tier is exhausted. A threshold no
    // grade can clear is a disabled feature.
    score -= 5;
    // Says which of the three possible causes it actually was. The generic
    // wording sent the owner to check an API key that was correctly set while
    // the real cause — a spent free tier — went unnamed.
    const why = signal.trade_plan.fallback_reason;
    factors.push(why ? `${why}（-5）` : "價位由預設規則挑選，未經 AI 判斷（-5）");
  }

  const bt = signal.plan_backtest;
  if (bt && bt.resolved >= 10) {
    // Only with a real sample. Below ~10 resolved cases the win rate is noise,
    // and letting noise move the headline number is how a made-up figure gets
    // laundered into looking evidence-based.
    const winRate = (bt.wins / bt.resolved) * 100;
    const delta = Math.max(-10, Math.min(10, Math.round((winRate - 50) / 5)));
    if (delta !== 0) {
      score += delta;
      factors.push(
        `本地回測 ${bt.resolved} 次中 ${bt.wins} 勝（${Math.round(winRate)}%，${delta > 0 ? "+" : ""}${delta}）`,
      );
    }
  } else if (bt) {
    factors.push(`本地回測樣本僅 ${bt.resolved} 次，不足以調整信心度`);
  }

  // 前進驗證證據 — the lab's own scoreboard, which was being measured and
  // then ignored unless a person pressed 採用. Bounded (+8 / −6), and only
  // here: a condition's forward record is measured under the lab's protocol,
  // not this plan's geometry, so it is evidence about direction and timing
  // — confidence's business — and never the grade's or the veto's.
  const fwd = forwardEvidenceDelta(signal.forward_evidence);
  if (fwd.factor) {
    score += fwd.delta;
    factors.push(fwd.factor);
  }

  const final = clamp(score);
  return { score: final, level: levelFor(final), factors };
}

/** Obstacles strictly between two prices, whichever way round they are. */
export function obstaclesBetween(
  obstacles: PathObstacle[],
  from: number,
  to: number,
): PathObstacle[] {
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  return obstacles.filter((o) => o.price > low && o.price < high);
}

/**
 * Confidence in reaching one specific target.
 *
 * Starts from the plan's own score, then subtracts for what stands in the way.
 * The two inputs are deliberate:
 *
 *  - **Obstacles in the path.** A target with two H4 resistances between it and
 *    the entry is a different proposition from a clear run, and the analysis
 *    already located them (`path_obstacles`). Weighted by strength, because a
 *    weekly level is not a minor shelf.
 *  - **Position in the sequence.** TP2 is further than TP1 by construction, so
 *    the ordinal is a distance proxy that needs no extra data and can't be
 *    gamed by a symbol's price scale.
 *
 * Distance in R deliberately does *not* appear. The spec forbids R-multiples
 * for placing levels; using them to score the same levels afterwards would
 * smuggle the same reasoning back in through the display.
 */
export function takeProfitConfidence(
  signal: TradeSignal,
  index: number,
  base: Confidence = planConfidence(signal),
): Confidence {
  const tp = signal.take_profits?.[index];
  if (!tp) return { score: 5, level: "low", factors: ["無此停利目標"] };

  const factors = [`交易整體信心度 ${base.score}`];
  let score = base.score;

  const entry =
    signal.trade_plan?.entry ?? (signal.entry_zone.low + signal.entry_zone.high) / 2;
  const blocking = obstaclesBetween(signal.path_obstacles ?? [], entry, tp.price);
  if (blocking.length > 0) {
    const weight = blocking.reduce((sum, o) => sum + o.strength, 0);
    const penalty = Math.min(30, weight * 4);
    score -= penalty;
    factors.push(
      `路徑上有 ${blocking.length} 個障礙（強度合計 ${weight}，-${penalty}）：` +
        blocking.map((o) => `${o.timeframe} ${o.type}`).join("、"),
    );
  } else {
    factors.push("進場價與此目標之間沒有已知障礙");
  }

  if (index > 0) {
    const penalty = index * 8;
    score -= penalty;
    factors.push(`第 ${index + 1} 個目標，距離較遠（-${penalty}）`);
  }

  const final = clamp(score);
  return { score: final, level: levelFor(final), factors };
}

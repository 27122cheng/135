import type { PathObstacle, TradeSignal } from "@/types/signal";

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
 * 60 is set so the grade still does the deciding and this stays a veto rather
 * than a second grading system:
 *
 *  - A+ (80) survives a bad data day and still trades
 *  - A (70) trades unless several sources are down
 *  - B (55) needs the geometry to be genuinely good to get over the line
 *  - C (40) cannot reach it at all, which matches `MIN_ENTRY_GRADE`
 *
 * The −10 for an AI-less plan still blocks most entries on its own. That is
 * intended: levels picked by the default rules are not a confident trade.
 */
export const CONFIDENT_ENTRY_MIN = 60;

export type ConfidenceLevel = "high" | "medium" | "low";

export interface Confidence {
  /** 0–100. Comparable between signals; not a probability. */
  score: number;
  level: ConfidenceLevel;
  /** Every contribution, in the order applied. Shown to the reader verbatim. */
  factors: string[];
}

const GRADE_BASE: Record<string, number> = {
  "A+": 80,
  A: 70,
  B: 55,
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

  const gaps = signal.data_gaps?.length ?? 0;
  if (gaps > 0) {
    const penalty = Math.min(15, gaps * 3);
    score -= penalty;
    factors.push(`${gaps} 項資料缺口（-${penalty}）`);
  }

  if (signal.trade_plan?.decided_by === "fallback") {
    score -= 10;
    factors.push("價位由預設規則挑選，未經 AI 判斷（-10）");
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

import { PREVENTABLE_TAGS, type JournalEntry, type StopReasonTag } from "@/types/journal";
import { INTERVENED_MARKER } from "./markers";

/**
 * 績效總覽 — 勝率、回撤、學習成長, in one honest report.
 *
 * Why this exists beside stats.ts: the review page already had the numbers,
 * scattered across six tables, and three things made them easy to misread.
 *
 * 1. **A win rate without its uncertainty.** 3 wins in 4 trades printed as
 *    「75%」 with the same confidence as 75 in 100. Every rate here carries a
 *    95% Wilson interval, and the headline says how many more trades it takes
 *    to narrow that interval to ±10 points — so a hot streak reads as a hot
 *    streak and not as a system.
 * 2. **No sense of direction.** 「有在學」 was a claim; the page could not
 *    show whether the book was getting better or worse. The resolved trades
 *    are cut into chronological thirds (前期 / 中期 / 近期) and compared on the
 *    metrics the learning loop is supposed to move: win rate, expectancy,
 *    the share of losses that were preventable, mean severity, drawdown.
 * 3. **No control group.** The intervention engine tightens signals after
 *    repeated stop reasons; nothing measured whether tightened trades did
 *    any better. Auto-logged rows now carry 「[已干涉 S2,S3]」 when the plan
 *    was taken under active tightenings, and this module reports the two
 *    populations side by side.
 *
 * Pure over an array of journal rows. The caller passes the stream it wants
 * judged — the API passes real trades only, because paper fills are perfect
 * and would flatter every number here.
 */

/** Below this many resolved trades the report refuses to issue a verdict. */
export const MIN_VERDICT_TRADES = 10;
/** Each chronological period needs this many resolved trades to be compared. */
export const MIN_PERIOD_TRADES = 5;
/** The operator's stated goal, drawn on the band so the gap is visible. */
export const TARGET_WIN_RATE = 80;
/** 95% two-sided. */
const Z = 1.96;

export interface WinRateEstimate {
  wins: number;
  losses: number;
  /** wins / (wins+losses) in percent, one decimal; null when nothing resolved. */
  rate: number | null;
  /** 95% Wilson interval bounds in percent. */
  low: number | null;
  high: number | null;
  /** Half-width of the interval in percentage points. */
  halfWidth: number | null;
}

export interface PeriodStats {
  label: string;
  from: string | null;
  to: string | null;
  trades: number;
  breakeven: number;
  winRate: WinRateEstimate;
  /** Mean pnl_pct over resolved trades (wins and losses). */
  expectancyPct: number | null;
  /** Gross wins ÷ gross losses; null without both sides. */
  profitFactor: number | null;
  /** Deepest fall from a running peak inside this period's own curve, ≤ 0. */
  maxDrawdownPct: number;
  /** Of tagged losses, the share whose tag a rule could have prevented, 0-100. */
  preventableSharePct: number | null;
  avgSeverity: number | null;
  /** Share of trades taken under active tightenings, 0-100. */
  intervenedSharePct: number | null;
}

export interface RollingPoint {
  closedAt: string;
  /** Win rate over the trailing window, percent. */
  winRate: number;
  /** Mean pnl over the trailing window. */
  expectancyPct: number;
  n: number;
}

export interface LearningDelta {
  metric: string;
  before: number | null;
  after: number | null;
  /** after − before, in the metric's own unit. */
  delta: number | null;
  /** True when the move is the direction the learning loop wants. */
  better: boolean | null;
  unit: "pt" | "%" | "" ;
}

export interface InterventionSplit {
  with: { trades: number; winRate: WinRateEstimate; expectancyPct: number | null };
  without: { trades: number; winRate: WinRateEstimate; expectancyPct: number | null };
  note: string;
}

export type VerdictLevel = "insufficient" | "improving" | "flat" | "worsening";

export interface PerformanceReport {
  trades: number;
  resolved: number;
  breakeven: number;
  winRate: WinRateEstimate;
  expectancyPct: number | null;
  profitFactor: number | null;
  /** Mean win ÷ |mean loss|. */
  payoffRatio: number | null;
  /** The win rate this payoff needs to break even, percent. */
  breakevenWinRate: number | null;
  totalPct: number;
  maxDrawdownPct: number;
  /** Where the curve sits below its running peak right now, ≤ 0. */
  currentDrawdownPct: number;
  /** totalPct ÷ |maxDrawdownPct|; how many drawdowns the profit has paid for. */
  recoveryFactor: number | null;
  longestLossStreak: number;
  /** Most consecutive trades spent below a prior peak. */
  longestUnderwater: number;
  periods: PeriodStats[];
  rolling: RollingPoint[];
  rollingWindow: number;
  learning: LearningDelta[];
  intervention: InterventionSplit | null;
  verdict: { level: VerdictLevel; headline: string; detail: string };
  /** How far the sample is from a trustworthy rate, in words. */
  sampleNote: string;
  /** Where the 80% goal stands against the interval, in words. */
  targetNote: string;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

function isResolved(e: JournalEntry): boolean {
  return e.result === "win" || e.result === "loss";
}

export function isIntervened(e: JournalEntry): boolean {
  return typeof e.review_note === "string" && e.review_note.includes(INTERVENED_MARKER);
}

/** Wilson score interval — the textbook fix for small-sample win rates. */
export function wilson(wins: number, losses: number): WinRateEstimate {
  const n = wins + losses;
  if (n === 0) return { wins, losses, rate: null, low: null, high: null, halfWidth: null };
  const p = wins / n;
  const z2 = Z * Z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    wins,
    losses,
    rate: r1(p * 100),
    low: r1(Math.max(0, centre - half) * 100),
    high: r1(Math.min(1, centre + half) * 100),
    halfWidth: r1(half * 100),
  };
}

/** Resolved trades needed before the 95% interval is within ±10 points of the rate. */
export function tradesForHalfWidth(rate: number | null, halfWidthPt = 10): number {
  // At an unknown or extreme rate assume the worst case p = 0.5; a rate that
  // is genuinely 80% needs fewer, and the formula rewards it honestly.
  const p = rate === null ? 0.5 : Math.min(0.8, Math.max(0.2, rate / 100));
  return Math.ceil((Z * Z * p * (1 - p)) / ((halfWidthPt / 100) ** 2));
}

function curveOf(chronological: JournalEntry[]) {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  let underwater = 0;
  let longestUnderwater = 0;
  let lossStreak = 0;
  let longestLossStreak = 0;
  for (const e of chronological) {
    equity += e.pnl_pct;
    if (equity >= peak) {
      peak = equity;
      underwater = 0;
    } else {
      underwater++;
      if (underwater > longestUnderwater) longestUnderwater = underwater;
    }
    const dd = equity - peak;
    if (dd < maxDd) maxDd = dd;
    if (e.result === "loss") {
      lossStreak++;
      if (lossStreak > longestLossStreak) longestLossStreak = lossStreak;
    } else if (e.result === "win") {
      lossStreak = 0;
    }
  }
  return {
    totalPct: r2(equity),
    maxDrawdownPct: r2(maxDd),
    currentDrawdownPct: r2(equity - peak),
    longestUnderwater,
    longestLossStreak,
  };
}

function periodOf(label: string, rows: JournalEntry[]): PeriodStats {
  const resolved = rows.filter(isResolved);
  const wins = resolved.filter((e) => e.result === "win");
  const losses = resolved.filter((e) => e.result === "loss");
  const gross = (list: JournalEntry[]) => list.reduce((s, e) => s + e.pnl_pct, 0);
  const grossWin = gross(wins);
  const grossLoss = -gross(losses);
  const tagged = losses.filter((e): e is JournalEntry & { stop_reason_tag: StopReasonTag } => e.stop_reason_tag !== null);
  const preventable = tagged.filter((e) => PREVENTABLE_TAGS[e.stop_reason_tag]);
  const scored = rows.filter((e) => e.severity !== null);
  const intervened = rows.filter(isIntervened);
  return {
    label,
    from: rows[0]?.closed_at ?? null,
    to: rows[rows.length - 1]?.closed_at ?? null,
    trades: rows.length,
    breakeven: rows.filter((e) => e.result === "breakeven").length,
    winRate: wilson(wins.length, losses.length),
    expectancyPct: resolved.length > 0 ? r2(gross(resolved) / resolved.length) : null,
    profitFactor: grossWin > 0 && grossLoss > 0 ? r2(grossWin / grossLoss) : null,
    maxDrawdownPct: curveOf(rows).maxDrawdownPct,
    preventableSharePct: tagged.length > 0 ? r1((preventable.length / tagged.length) * 100) : null,
    avgSeverity:
      scored.length > 0 ? r2(scored.reduce((s, e) => s + (e.severity ?? 0), 0) / scored.length) : null,
    intervenedSharePct: rows.length > 0 ? r1((intervened.length / rows.length) * 100) : null,
  };
}

/** Chronological thirds, each with at least MIN_PERIOD_TRADES resolved trades. */
function splitPeriods(chronological: JournalEntry[]): PeriodStats[] {
  const resolvedCount = chronological.filter(isResolved).length;
  const parts = resolvedCount >= MIN_PERIOD_TRADES * 3 ? 3 : resolvedCount >= MIN_PERIOD_TRADES * 2 ? 2 : 1;
  const labels = parts === 3 ? ["前期", "中期", "近期"] : parts === 2 ? ["前期", "近期"] : ["全部"];
  const size = Math.ceil(chronological.length / parts);
  const out: PeriodStats[] = [];
  for (let i = 0; i < parts; i++) {
    out.push(periodOf(labels[i], chronological.slice(i * size, (i + 1) * size)));
  }
  return out;
}

function rollingOf(resolved: JournalEntry[], window: number): RollingPoint[] {
  const points: RollingPoint[] = [];
  for (let i = window - 1; i < resolved.length; i++) {
    const slice = resolved.slice(i - window + 1, i + 1);
    const wins = slice.filter((e) => e.result === "win").length;
    points.push({
      closedAt: resolved[i].closed_at,
      winRate: r1((wins / slice.length) * 100),
      expectancyPct: r2(slice.reduce((s, e) => s + e.pnl_pct, 0) / slice.length),
      n: slice.length,
    });
  }
  return points;
}

function delta(
  metric: string,
  before: number | null,
  after: number | null,
  higherIsBetter: boolean,
  unit: LearningDelta["unit"],
): LearningDelta {
  if (before === null || after === null) return { metric, before, after, delta: null, better: null, unit };
  const d = r2(after - before);
  return { metric, before, after, delta: d, better: d === 0 ? null : higherIsBetter ? d > 0 : d < 0, unit };
}

function learningOf(periods: PeriodStats[]): LearningDelta[] {
  if (periods.length < 2) return [];
  const first = periods[0];
  const last = periods[periods.length - 1];
  return [
    delta("勝率", first.winRate.rate, last.winRate.rate, true, "pt"),
    delta("期望值／筆", first.expectancyPct, last.expectancyPct, true, "%"),
    delta("可預防虧損占比", first.preventableSharePct, last.preventableSharePct, false, "pt"),
    delta("平均 severity", first.avgSeverity, last.avgSeverity, false, ""),
    // Drawdown is ≤ 0: a shallower (less negative) number is better.
    delta("期內最大回撤", first.maxDrawdownPct, last.maxDrawdownPct, true, "%"),
  ];
}

function interventionOf(rows: JournalEntry[]): InterventionSplit | null {
  const withRows = rows.filter(isIntervened);
  const withoutRows = rows.filter((e) => !isIntervened(e));
  if (withRows.filter(isResolved).length === 0) return null;
  const side = (list: JournalEntry[]) => {
    const resolved = list.filter(isResolved);
    return {
      trades: list.length,
      winRate: wilson(
        resolved.filter((e) => e.result === "win").length,
        resolved.filter((e) => e.result === "loss").length,
      ),
      expectancyPct:
        resolved.length > 0 ? r2(resolved.reduce((s, e) => s + e.pnl_pct, 0) / resolved.length) : null,
    };
  };
  const w = side(withRows);
  const wo = side(withoutRows);
  const enough = w.trades >= MIN_PERIOD_TRADES && wo.trades >= MIN_PERIOD_TRADES;
  const note = !enough
    ? `兩組各需至少 ${MIN_PERIOD_TRADES} 筆才能比較（已干涉 ${w.trades} 筆、未干涉 ${wo.trades} 筆）。`
    : w.expectancyPct !== null && wo.expectancyPct !== null && w.expectancyPct > wo.expectancyPct
      ? "已干涉的交易期望值較高：停損復盤的收緊有在賺錢。"
      : "已干涉的交易並沒有比較好：收緊規則本身值得檢討，不是只檢討進場。";
  return { with: w, without: wo, note };
}

function verdictOf(
  resolved: number,
  learning: LearningDelta[],
  periods: PeriodStats[],
): PerformanceReport["verdict"] {
  if (resolved < MIN_VERDICT_TRADES) {
    return {
      level: "insufficient",
      headline: `樣本不足（${resolved} 筆結算）`,
      detail: `至少 ${MIN_VERDICT_TRADES} 筆結算才判斷趨勢；現在的勝率是一段手感，不是一套系統的成績。`,
    };
  }
  const judged = learning.filter((d) => d.better !== null);
  if (periods.length < 2 || judged.length === 0) {
    return {
      level: "flat",
      headline: "尚無法比較前後期",
      detail: `每一期至少 ${MIN_PERIOD_TRADES} 筆結算才能切成前期／近期；再累積幾筆就會出現。`,
    };
  }
  const better = judged.filter((d) => d.better).length;
  const worse = judged.length - better;
  const exp = learning.find((d) => d.metric === "期望值／筆");
  const expUp = exp?.better === true;
  const expDown = exp?.better === false;
  const first = periods[0].label;
  const last = periods[periods.length - 1].label;
  // A drawdown delta reads backwards as a signed number (+0.8% means the
  // hole got shallower), so that one is said in words.
  const summary = judged
    .map((d) =>
      d.metric === "期內最大回撤"
        ? `${d.metric}${d.better ? "收窄" : "加深"} ${Math.abs(d.delta ?? 0)}%`
        : `${d.metric} ${d.delta !== null && d.delta > 0 ? "+" : ""}${d.delta}${d.unit}`,
    )
    .join("、");
  if (expUp && better >= Math.ceil(judged.length / 2)) {
    return {
      level: "improving",
      headline: `學習有成效：${last}優於${first}`,
      detail: `${judged.length} 項指標中 ${better} 項改善（${summary}）。繼續讓停損復盤跑，不要手動放寬門檻。`,
    };
  }
  if (expDown && worse >= Math.ceil(judged.length / 2)) {
    return {
      level: "worsening",
      headline: `${last}比${first}差：學習尚未見效`,
      detail: `${judged.length} 項指標中 ${worse} 項退步（${summary}）。先看「可預防虧損占比」有沒有降 —— 沒降代表收緊沒有打中真正的停損原因。`,
    };
  }
  return {
    level: "flat",
    headline: `${first}與${last}互有進退`,
    detail: `${summary}。期望值沒有明確方向時，先累積樣本，不要改規則。`,
  };
}

export function computePerformance(entries: JournalEntry[]): PerformanceReport {
  const chronological = [...entries].sort((a, b) => a.closed_at.localeCompare(b.closed_at));
  const resolvedRows = chronological.filter(isResolved);
  const wins = resolvedRows.filter((e) => e.result === "win");
  const losses = resolvedRows.filter((e) => e.result === "loss");
  const gross = (list: JournalEntry[]) => list.reduce((s, e) => s + e.pnl_pct, 0);
  const grossWin = gross(wins);
  const grossLoss = -gross(losses);
  const avgWin = wins.length > 0 ? grossWin / wins.length : null;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : null;
  const payoff = avgWin !== null && avgLoss !== null && avgLoss > 0 ? avgWin / avgLoss : null;

  const winRate = wilson(wins.length, losses.length);
  const curve = curveOf(chronological);
  const periods = splitPeriods(chronological);
  const learning = learningOf(periods);
  const rollingWindow = resolvedRows.length >= 30 ? 20 : 10;
  const rolling = resolvedRows.length >= rollingWindow ? rollingOf(resolvedRows, rollingWindow) : [];
  const verdict = verdictOf(resolvedRows.length, learning, periods);

  const need = tradesForHalfWidth(winRate.rate);
  const sampleNote =
    winRate.rate === null
      ? "還沒有結算的正式訊號，勝率無從談起。"
      : winRate.halfWidth !== null && winRate.halfWidth <= 10
        ? `${resolvedRows.length} 筆結算，95% 區間 ${winRate.low}–${winRate.high}%：樣本已足夠把勝率當成績看。`
        : `${resolvedRows.length} 筆結算，95% 區間 ${winRate.low}–${winRate.high}%（±${winRate.halfWidth} pt）；` +
          `大約還要 ${Math.max(0, need - resolvedRows.length)} 筆才能縮到 ±10 pt。`;

  const breakevenWinRate = payoff !== null ? r1((1 / (1 + payoff)) * 100) : null;
  const targetNote =
    winRate.high === null
      ? `目標勝率 ${TARGET_WIN_RATE}%。`
      : winRate.low !== null && winRate.low >= TARGET_WIN_RATE
        ? `目標 ${TARGET_WIN_RATE}%：連區間下緣都在目標之上，已達成。`
        : winRate.high >= TARGET_WIN_RATE
          ? `目標 ${TARGET_WIN_RATE}%：仍在統計可能範圍內（區間上緣 ${winRate.high}%），但尚未證明。`
          : `目標 ${TARGET_WIN_RATE}%：以現有 ${resolvedRows.length} 筆看，區間上緣只到 ${winRate.high}%，目標不在可能範圍內` +
            (breakevenWinRate !== null
              ? `；以目前賠率，勝率高於 ${breakevenWinRate}% 就是正期望，這才是該先守住的線。`
              : "。");

  return {
    trades: chronological.length,
    resolved: resolvedRows.length,
    breakeven: chronological.filter((e) => e.result === "breakeven").length,
    winRate,
    expectancyPct: resolvedRows.length > 0 ? r2(gross(resolvedRows) / resolvedRows.length) : null,
    profitFactor: grossWin > 0 && grossLoss > 0 ? r2(grossWin / grossLoss) : null,
    payoffRatio: payoff === null ? null : r2(payoff),
    breakevenWinRate,
    totalPct: curve.totalPct,
    maxDrawdownPct: curve.maxDrawdownPct,
    currentDrawdownPct: curve.currentDrawdownPct,
    recoveryFactor:
      curve.maxDrawdownPct < 0 ? r2(curve.totalPct / -curve.maxDrawdownPct) : null,
    longestLossStreak: curve.longestLossStreak,
    longestUnderwater: curve.longestUnderwater,
    periods,
    rolling,
    rollingWindow,
    learning,
    intervention: interventionOf(chronological),
    verdict,
    sampleNote,
    targetNote,
  };
}

/** One Telegram-sized line for the weekly digest: where the learning stands. */
export function performanceLine(report: PerformanceReport): string | null {
  if (report.resolved === 0) return null;
  const wr = report.winRate;
  const head =
    `勝率 ${wr.rate}%（${report.resolved} 筆，95% 區間 ${wr.low}–${wr.high}%）` +
    `，最大回撤 ${report.maxDrawdownPct}%`;
  return `${head}；${report.verdict.headline}`;
}

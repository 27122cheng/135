import {
  STOP_REASON_LABELS,
  type JournalEntry,
  type StopReasonTag,
} from "@/types/journal";

/**
 * The four views /review asks for, computed from journal entries only.
 * Pure functions over an array — no fetching, no AI, so the page and the tests
 * see identical numbers.
 */

export interface TagDistribution {
  tag: StopReasonTag;
  label: string;
  count: number;
  /** Share of all tagged losses, 0-100. */
  sharePct: number;
  avgSeverity: number | null;
  /** Sum of pnl_pct across these entries — negative. */
  cumulativeLossPct: number;
}

export interface SeverityPoint {
  closedAt: string;
  severity: number;
  /** Mean severity of this entry and the 4 before it; smooths a noisy series. */
  rollingMean: number;
}

export interface GradePerformance {
  grade: string;
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  /** Wins / (wins + losses); null when nothing has resolved yet. */
  winRate: number | null;
  /** Mean pnl_pct across all trades of this grade. */
  expectancyPct: number | null;
}

export interface ReviewStats {
  totalEntries: number;
  tagDistribution: TagDistribution[];
  severityTrend: SeverityPoint[];
  /** Worst first — the tag costing the most, which is what to fix next. */
  lossRanking: TagDistribution[];
  gradePerformance: GradePerformance[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeReviewStats(entries: JournalEntry[]): ReviewStats {
  const tagged = entries.filter((e) => e.stop_reason_tag !== null);

  const byTag = new Map<StopReasonTag, JournalEntry[]>();
  for (const e of tagged) {
    const tag = e.stop_reason_tag as StopReasonTag;
    byTag.set(tag, [...(byTag.get(tag) ?? []), e]);
  }

  const tagDistribution: TagDistribution[] = Array.from(byTag.entries())
    .map(([tag, list]) => {
      const scored = list.filter((e) => e.severity !== null);
      return {
        tag,
        label: STOP_REASON_LABELS[tag],
        count: list.length,
        sharePct: tagged.length > 0 ? round2((list.length / tagged.length) * 100) : 0,
        avgSeverity:
          scored.length > 0
            ? round2(scored.reduce((s, e) => s + (e.severity ?? 0), 0) / scored.length)
            : null,
        cumulativeLossPct: round2(list.reduce((s, e) => s + e.pnl_pct, 0)),
      };
    })
    .sort((a, b) => b.count - a.count);

  // Chronological for a trend line; the store hands entries back newest-first.
  const chronological = [...entries]
    .filter((e) => e.severity !== null)
    .sort((a, b) => a.closed_at.localeCompare(b.closed_at));

  const severityTrend: SeverityPoint[] = chronological.map((e, i) => {
    const window = chronological.slice(Math.max(0, i - 4), i + 1);
    return {
      closedAt: e.closed_at,
      severity: e.severity ?? 0,
      rollingMean: round2(window.reduce((s, w) => s + (w.severity ?? 0), 0) / window.length),
    };
  });

  const lossRanking = [...tagDistribution].sort(
    (a, b) => a.cumulativeLossPct - b.cumulativeLossPct,
  );

  const grades = ["A+", "A", "B", "C", "no-trade"];
  const gradePerformance: GradePerformance[] = grades
    .map((grade) => {
      const list = entries.filter((e) => e.grade === grade);
      const wins = list.filter((e) => e.result === "win").length;
      const losses = list.filter((e) => e.result === "loss").length;
      const breakeven = list.filter((e) => e.result === "breakeven").length;
      const resolved = wins + losses;
      return {
        grade,
        trades: list.length,
        wins,
        losses,
        breakeven,
        // Breakeven trades are excluded from the rate but kept in expectancy —
        // they aren't wins, and counting them as losses would understate the edge.
        winRate: resolved > 0 ? round2((wins / resolved) * 100) : null,
        expectancyPct:
          list.length > 0 ? round2(list.reduce((s, e) => s + e.pnl_pct, 0) / list.length) : null,
      };
    })
    .filter((g) => g.trades > 0);

  return {
    totalEntries: entries.length,
    tagDistribution,
    severityTrend,
    lossRanking,
    gradePerformance,
  };
}


/**
 * 實際命中率 — the system's own trades, marked to market by the monitor.
 *
 * Split three ways because the three streams answer different questions and
 * mixing them flatters all of them:
 *
 *  - **正式訊號（自動追蹤）**: plans the system recommended and the monitor
 *    watched to resolution. The number that decides whether to trust it.
 *  - **參考價位（紙上追蹤）**: plans the rules stood aside from, tracked on
 *    paper anyway. If this bucket beats the real one over a real sample, the
 *    entry gate is costing money and the thresholds deserve another look; if
 *    it loses, the gate is earning its keep. Fills are assumed perfect, so it
 *    reads optimistically — stated wherever shown.
 *  - **人工記錄**: hand-entered trades, whatever their story.
 */
export interface TrackBucket {
  label: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgPnlPct: number | null;
  /**
   * 期望值 — the number 勝率 keeps getting mistaken for.
   *
   * A 70% win rate losing money and a 40% win rate making it are both
   * ordinary outcomes; which one you have depends entirely on the payoff
   * ratio, and a review page that headlines 勝率 without it teaches the
   * wrong lesson. Expectancy is mean pnl per resolved trade; the breakeven
   * win rate is the rate this payoff ratio *requires* — a real win rate
   * above it is profit, below it is loss, whatever the raw percentage
   * looks like.
   */
  avgWinPct: number | null;
  avgLossPct: number | null;
  /** avgWin ÷ |avgLoss| — how much a winner pays for each loser's cost. */
  payoffRatio: number | null;
  expectancyPct: number | null;
  breakevenWinRate: number | null;
  /** Newest first, capped — enough to eyeball the streak. */
  recent: Array<{ symbol: string; result: string; pnlPct: number; closedAt: string }>;
}

export interface TrackRecord {
  real: TrackBucket;
  paper: TrackBucket;
  manual: TrackBucket;
}

const AUTO = "[自動追蹤]";
const PAPER = "[參考價位紙上追蹤]";

function bucketOf(label: string, entries: JournalEntry[]): TrackBucket {
  const winRows = entries.filter((e) => e.result === "win");
  const lossRows = entries.filter((e) => e.result === "loss");
  const wins = winRows.length;
  const losses = lossRows.length;
  const resolved = wins + losses;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const mean = (rows: JournalEntry[]) =>
    rows.length > 0 ? rows.reduce((s, e) => s + e.pnl_pct, 0) / rows.length : null;
  const avgWin = mean(winRows);
  const avgLoss = mean(lossRows);
  // Payoff needs both sides observed and a loss that actually cost something —
  // a zero or positive "average loss" (breakeven exits tagged loss) would put
  // nonsense in a denominator.
  const payoff = avgWin !== null && avgLoss !== null && avgLoss < 0 ? avgWin / -avgLoss : null;
  return {
    label,
    trades: entries.length,
    wins,
    losses,
    winRate: resolved > 0 ? Math.round((wins / resolved) * 1000) / 10 : null,
    avgPnlPct:
      entries.length > 0
        ? Math.round((entries.reduce((s, e) => s + e.pnl_pct, 0) / entries.length) * 100) / 100
        : null,
    avgWinPct: avgWin === null ? null : r2(avgWin),
    avgLossPct: avgLoss === null ? null : r2(avgLoss),
    payoffRatio: payoff === null ? null : r2(payoff),
    expectancyPct:
      resolved > 0
        ? r2(([...winRows, ...lossRows].reduce((s, e) => s + e.pnl_pct, 0)) / resolved)
        : null,
    // The win rate this payoff ratio needs just to break even:
    // p·W − (1−p)·L = 0  ⟹  p = L / (W + L)  with W, L as magnitudes.
    breakevenWinRate:
      payoff !== null ? Math.round((1 / (1 + payoff)) * 1000) / 10 : null,
    recent: entries.slice(0, 8).map((e) => ({
      symbol: e.symbol,
      result: e.result,
      pnlPct: e.pnl_pct,
      closedAt: e.closed_at.slice(0, 10),
    })),
  };
}

/**
 * 權益曲線與最大回撤 — the two numbers a desk looks at before any win rate.
 *
 * Additive in pnl percentage points rather than compounded: journal entries
 * carry pnl as a percent of entry price, position sizes are unknown (account
 * size deliberately never leaves the browser), and compounding invented
 * numbers would dress a measurement up as a simulation. Each point is the
 * running sum of pnl_pct in close order — "one unit risked per trade" — which
 * is exactly comparable across time and immune to sizing assumptions.
 *
 * Max drawdown is measured on that curve: the deepest fall from any running
 * peak, in the same percentage points. It answers the question the win rate
 * hides — how much pain sat between the peaks — and a rising curve with a
 * shallow drawdown is the actual goal the operator's two standing complaints
 * (交易量、勝率) are proxies for.
 */
export interface EquityPoint {
  closedAt: string;
  symbol: string;
  pnlPct: number;
  /** Running sum of pnl_pct up to and including this trade. */
  equityPct: number;
  /** Drawdown from the running peak at this point, ≤ 0. */
  drawdownPct: number;
}

export interface EquityCurve {
  points: EquityPoint[];
  /** Final running sum — where the curve ends. */
  totalPct: number;
  /** Deepest fall from a running peak, ≤ 0. */
  maxDrawdownPct: number;
  /** When the deepest drawdown bottomed, for the marker on the chart. */
  maxDrawdownAt: string | null;
  /** Longest run of consecutive losses — the streak risk sizing must survive. */
  longestLossStreak: number;
  currentStreak: { kind: "win" | "loss" | "none"; length: number };
}

export function computeEquityCurve(entries: JournalEntry[]): EquityCurve {
  const chronological = [...entries].sort((a, b) => a.closed_at.localeCompare(b.closed_at));
  const points: EquityPoint[] = [];
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  let maxDdAt: string | null = null;
  let lossStreak = 0;
  let longestLossStreak = 0;
  for (const e of chronological) {
    equity += e.pnl_pct;
    if (equity > peak) peak = equity;
    const dd = equity - peak;
    if (dd < maxDd) {
      maxDd = dd;
      maxDdAt = e.closed_at;
    }
    if (e.result === "loss") {
      lossStreak++;
      if (lossStreak > longestLossStreak) longestLossStreak = lossStreak;
    } else if (e.result === "win") {
      lossStreak = 0;
    }
    points.push({
      closedAt: e.closed_at,
      symbol: e.symbol,
      pnlPct: round2(e.pnl_pct),
      equityPct: round2(equity),
      drawdownPct: round2(dd),
    });
  }
  // The streak the reader is currently living through, newest backwards.
  let currentStreak: EquityCurve["currentStreak"] = { kind: "none", length: 0 };
  for (let i = chronological.length - 1; i >= 0; i--) {
    const r = chronological[i].result;
    if (r !== "win" && r !== "loss") continue;
    if (currentStreak.kind === "none") currentStreak = { kind: r, length: 1 };
    else if (currentStreak.kind === r) currentStreak.length++;
    else break;
  }
  return {
    points,
    totalPct: round2(equity),
    maxDrawdownPct: round2(maxDd),
    maxDrawdownAt: maxDdAt,
    longestLossStreak,
    currentStreak,
  };
}

export function computeTrackRecord(entries: JournalEntry[]): TrackRecord {
  const paper = entries.filter((e) => e.review_note?.includes(PAPER));
  const real = entries.filter((e) => e.review_note?.includes(AUTO) && !e.review_note?.includes(PAPER));
  const manual = entries.filter((e) => !e.review_note?.includes(AUTO));
  return {
    real: bucketOf("正式訊號（自動追蹤）", real),
    paper: bucketOf("參考價位（紙上追蹤，假設完美成交）", paper),
    manual: bucketOf("人工記錄", manual),
  };
}

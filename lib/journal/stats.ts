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
  const wins = entries.filter((e) => e.result === "win").length;
  const losses = entries.filter((e) => e.result === "loss").length;
  const resolved = wins + losses;
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
    recent: entries.slice(0, 8).map((e) => ({
      symbol: e.symbol,
      result: e.result,
      pnlPct: e.pnl_pct,
      closedAt: e.closed_at.slice(0, 10),
    })),
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

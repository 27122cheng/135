import type { JournalEntry } from "@/types/journal";
import { exitKindOf, EXIT_KIND_LABELS } from "./exit-kind";
import { wilson } from "./performance";

/**
 * 盤中策略與交易紀錄 — the daily (or weekly / monthly) trade report.
 *
 * The shape a trading room publishes: a date, four summary numbers, points
 * per instrument, and every settled trade with its direction, entry, exit
 * and result. Built from the journal the monitor writes, so each row is a
 * trade the system actually recommended and settled — nothing is typed in.
 *
 * Three honesty rules the published version of this report usually breaks:
 *  - 勝率 carries its 95% interval and the sample size; 19 trades is a
 *    day, not a record.
 *  - 盈虧比 is gross profit ÷ gross loss (the profit factor) on percent
 *    moves, not a ratio of point counts across instruments priced in
 *    different units.
 *  - 回撤 is measured on the running equity curve of the period, in the
 *    same percent-of-entry units every other page uses.
 *
 * Points are shown because a desk reads them, but labelled for what they
 * are: price distance captured, in the instrument's own units.
 */

export type ReportRange = "day" | "week" | "month";

export interface ReportRow {
  symbol: string;
  label: string;
  direction: "long" | "short";
  entry: number;
  exit: number;
  /** Signed price distance in the instrument's units. */
  points: number;
  pnlPct: number;
  result: JournalEntry["result"];
  exitKind: string;
  closedAt: string;
  /** Paper (參考價位) rows are listed but never counted. */
  paper: boolean;
}

export interface SymbolPoints {
  symbol: string;
  label: string;
  trades: number;
  winPoints: number;
  lossPoints: number;
  netPoints: number;
  netPct: number;
}

export interface ReportSummary {
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number | null;
  winRateLow: number | null;
  winRateHigh: number | null;
  profitFactor: number | null;
  grossWinPct: number;
  grossLossPct: number;
  netPct: number;
  maxDrawdownPct: number;
}

export interface DailyReport {
  range: ReportRange;
  /** Period bounds in the report time zone, as YYYY-MM-DD. */
  from: string;
  to: string;
  tz: string;
  summary: ReportSummary;
  /** All-time, for the 歷史參考 line. */
  historical: ReportSummary;
  bySymbol: SymbolPoints[];
  rows: ReportRow[];
  paperCount: number;
  notes: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const PAPER = "[參考價位紙上追蹤]";

/** YYYY-MM-DD of an instant in a time zone. */
export function dayIn(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Period bounds (inclusive day strings) containing `date`. */
export function periodBounds(date: string, range: ReportRange): { from: string; to: string } {
  const d = new Date(`${date}T00:00:00Z`);
  if (range === "day") return { from: date, to: date };
  if (range === "week") {
    const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
    const start = new Date(d.getTime() - dow * 86_400_000);
    const end = new Date(start.getTime() + 6 * 86_400_000);
    return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
  }
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

function summarise(rows: JournalEntry[]): ReportSummary {
  const sorted = [...rows].sort((a, b) => a.closed_at.localeCompare(b.closed_at));
  const wins = sorted.filter((e) => e.result === "win");
  const losses = sorted.filter((e) => e.result === "loss");
  const grossWin = wins.reduce((s, e) => s + e.pnl_pct, 0);
  const grossLoss = -losses.reduce((s, e) => s + e.pnl_pct, 0);
  const wr = wilson(wins.length, losses.length);
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const e of sorted) {
    equity += e.pnl_pct;
    if (equity > peak) peak = equity;
    if (equity - peak < maxDd) maxDd = equity - peak;
  }
  return {
    trades: sorted.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: sorted.filter((e) => e.result === "breakeven").length,
    winRate: wr.rate,
    winRateLow: wr.low,
    winRateHigh: wr.high,
    profitFactor: grossWin > 0 && grossLoss > 0 ? r2(grossWin / grossLoss) : null,
    grossWinPct: r2(grossWin),
    grossLossPct: r2(-grossLoss),
    netPct: r2(grossWin - grossLoss),
    maxDrawdownPct: r2(maxDd),
  };
}

export function buildDailyReport(
  entries: JournalEntry[],
  options: { date: string; range?: ReportRange; tz?: string; labels?: Record<string, string> },
): DailyReport {
  const range = options.range ?? "day";
  const tz = options.tz ?? "Asia/Taipei";
  const labels = options.labels ?? {};
  const { from, to } = periodBounds(options.date, range);
  const inPeriod = entries.filter((e) => {
    const day = dayIn(e.closed_at, tz);
    return day >= from && day <= to;
  });
  const real = inPeriod.filter((e) => !e.review_note?.includes(PAPER));
  const paper = inPeriod.filter((e) => e.review_note?.includes(PAPER));
  const allReal = entries.filter((e) => !e.review_note?.includes(PAPER));

  const toRow = (e: JournalEntry, isPaper: boolean): ReportRow => {
    const move = e.direction === "long" ? e.exit_price - e.entry_price : e.entry_price - e.exit_price;
    return {
      symbol: e.symbol,
      label: labels[e.symbol] ?? e.symbol,
      direction: e.direction,
      entry: e.entry_price,
      exit: e.exit_price,
      points: r2(move),
      pnlPct: r2(e.pnl_pct),
      result: e.result,
      exitKind: EXIT_KIND_LABELS[exitKindOf(e)],
      closedAt: e.closed_at,
      paper: isPaper,
    };
  };
  const rows = [...real.map((e) => toRow(e, false)), ...paper.map((e) => toRow(e, true))].sort((a, b) =>
    b.closedAt.localeCompare(a.closedAt),
  );

  const bySymbolMap = new Map<string, SymbolPoints>();
  for (const r of rows.filter((x) => !x.paper)) {
    const s = bySymbolMap.get(r.symbol) ?? { symbol: r.symbol, label: r.label, trades: 0, winPoints: 0, lossPoints: 0, netPoints: 0, netPct: 0 };
    s.trades++;
    if (r.points > 0) s.winPoints = r2(s.winPoints + r.points);
    else s.lossPoints = r2(s.lossPoints + r.points);
    s.netPoints = r2(s.netPoints + r.points);
    s.netPct = r2(s.netPct + r.pnlPct);
    bySymbolMap.set(r.symbol, s);
  }
  const bySymbol = [...bySymbolMap.values()].sort((a, b) => b.netPct - a.netPct);

  const summary = summarise(real);
  const notes = [
    "只計入系統建議且已結算的正式訊號；參考價位的紙上追蹤列出但不計入。",
    "勝率不含打平；盈虧比 = 總獲利 ÷ 總虧損（以進場價百分比計）；回撤以期內權益曲線計。",
    "點數 = 進出場價差（各商品單位不同，不能跨商品相加）；不代表實際收益。",
  ];
  if (summary.trades > 0 && summary.trades < 10) notes.push(`${summary.trades} 筆是一段手感，不是成績：95% 區間 ${summary.winRateLow ?? "—"}–${summary.winRateHigh ?? "—"}%。`);

  return { range, from, to, tz, summary, historical: summarise(allReal), bySymbol, rows, paperCount: paper.length, notes };
}

/** Telegram-ready plain text of the same report. */
export function reportText(report: DailyReport): string {
  const s = report.summary;
  const period = report.range === "day" ? report.from : `${report.from} ～ ${report.to}`;
  const lines = [
    `<b>盤中策略與交易紀錄 ${period}</b>`,
    s.trades === 0
      ? "本期 0 筆結算。"
      : `有效記錄 ${s.trades} 筆｜勝率 ${s.winRate ?? "—"}%（${s.winRateLow}–${s.winRateHigh}）｜盈虧比 ${s.profitFactor ?? "—"}｜最大回撤 ${s.maxDrawdownPct}%｜淨 ${s.netPct > 0 ? "+" : ""}${s.netPct}%`,
    `歷史參考：${report.historical.trades} 筆，勝率 ${report.historical.winRate ?? "—"}%，盈虧比 ${report.historical.profitFactor ?? "—"}，最大回撤 ${report.historical.maxDrawdownPct}%`,
  ];
  if (report.bySymbol.length > 0) {
    lines.push("", ...report.bySymbol.map((b) => `${b.label}：盈 ${b.winPoints}・損 ${Math.abs(b.lossPoints)}（淨 ${b.netPct > 0 ? "+" : ""}${b.netPct}%）`));
  }
  const real = report.rows.filter((r) => !r.paper);
  if (real.length > 0) {
    lines.push("", ...real.map((r) => `${r.label} ${r.direction === "long" ? "多" : "空"} ${r.entry} → ${r.exit}　${r.points > 0 ? "+" : ""}${r.points}（${r.pnlPct > 0 ? "+" : ""}${r.pnlPct}%）${r.exitKind}`));
  }
  lines.push("", `<i>${report.notes[0]}</i>`);
  return lines.join("\n");
}

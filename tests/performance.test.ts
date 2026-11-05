import { check, report } from "./_harness";
import {
  computePerformance,
  isIntervened,
  MIN_VERDICT_TRADES,
  performanceLine,
  tradesForHalfWidth,
  wilson,
} from "@/lib/journal/performance";
import { intervenedMarker } from "@/lib/journal/markers";
import type { JournalEntry } from "@/types/journal";

/** 績效總覽 — honest win rate, drawdown and whether the learning is working. */

let seq = 0;
function row(over: Partial<JournalEntry> = {}): JournalEntry {
  seq++;
  const day = String(Math.min(28, Math.floor(seq / 2) + 1)).padStart(2, "0");
  const hour = String(seq % 24).padStart(2, "0");
  return {
    id: `j-${seq}`, signal_id: null, symbol: "XAUUSD", direction: "long", grade: "B",
    entry_price: 2000, exit_price: 1980, result: "loss", pnl_pct: -1,
    closed_at: `2026-09-${day}T${hour}:00:00.000Z`,
    stop_reason_tag: "S2", severity: 3, review_note: "[自動追蹤] 觸及停損 1980",
    created_at: "2026-09-01T00:00:00.000Z", ...over,
  };
}
const win = (pnl = 2) => row({ result: "win", pnl_pct: pnl, stop_reason_tag: null, severity: null });
const loss = (pnl = -1, tag: JournalEntry["stop_reason_tag"] = "S2", severity = 3) =>
  row({ result: "loss", pnl_pct: pnl, stop_reason_tag: tag, severity });

// ── the interval ──────────────────────────────────────────────────
{
  const three = wilson(3, 1);
  check("3 of 4 is 75%", three.rate === 75, three);
  check("but the interval is wide", three.low !== null && three.low < 35 && three.high !== null && three.high > 90, three);
  const many = wilson(75, 25);
  check("75 of 100 is the same rate", many.rate === 75);
  check("with a much tighter band", many.halfWidth !== null && many.halfWidth < 10, many);
  check("nothing resolved means no rate", wilson(0, 0).rate === null);
  check("±10 pt at a coin flip needs ~96 trades", tradesForHalfWidth(50) === 97 || tradesForHalfWidth(50) === 96, tradesForHalfWidth(50));
  check("a genuine 80% needs fewer", tradesForHalfWidth(80) < tradesForHalfWidth(50));
}

// ── too few trades: no verdict, said plainly ───────────────────────
{
  const r = computePerformance([win(), win(), loss()]);
  check("below the floor the verdict is insufficient", r.verdict.level === "insufficient", r.verdict);
  check("and names the floor", r.verdict.detail.includes(String(MIN_VERDICT_TRADES)));
  check("the sample note says how many more", r.sampleNote.includes("還要"), r.sampleNote);
  check("80% is still statistically possible on 3 trades", r.targetNote.includes("可能範圍內") && !r.targetNote.includes("不在"), r.targetNote);
  check("empty input does not throw", computePerformance([]).winRate.rate === null);
}

// ── drawdown accounting ───────────────────────────────────────────
{
  seq = 0;
  const rows = [win(2), win(1), loss(-2), loss(-1), win(0.5), win(3)];
  const r = computePerformance(rows);
  check("total is the running sum", r.totalPct === 3.5, r.totalPct);
  check("max drawdown is the deepest fall from a peak", r.maxDrawdownPct === -3, r.maxDrawdownPct);
  check("the curve ended at a new high so current drawdown is 0", r.currentDrawdownPct === 0, r.currentDrawdownPct);
  check("underwater streak counted", r.longestUnderwater === 3, r.longestUnderwater);
  check("longest loss streak", r.longestLossStreak === 2);
  check("recovery factor = total ÷ |maxDD|", r.recoveryFactor !== null && Math.abs(r.recoveryFactor - 1.17) < 0.01, r.recoveryFactor);
  check("profit factor = gross win ÷ gross loss", r.profitFactor !== null && Math.abs(r.profitFactor - 6.5 / 3) < 0.01, r.profitFactor);
}

// ── learning growth: a book that got better ───────────────────────
{
  seq = 0;
  // Early: 2 wins 4 losses, all preventable S2. Middle: mixed. Late: 5 wins 1
  // loss, and the one loss was an unpreventable S4 event.
  const early = [win(1), loss(-1.5), loss(-1.5), win(1), loss(-1.5), loss(-1.5)];
  const mid = [win(1.5), loss(-1), win(1.5), loss(-1), win(1.5), loss(-1, "S3")];
  const late = [win(2), win(2), loss(-1, "S4", 1), win(2), win(2), win(2)];
  const r = computePerformance([...early, ...mid, ...late]);
  check("three periods", r.periods.map((p) => p.label).join() === "前期,中期,近期", r.periods.map((p) => p.label));
  check("early win rate is low", r.periods[0].winRate.rate !== null && r.periods[0].winRate.rate < 40, r.periods[0].winRate);
  check("late win rate is high", r.periods[2].winRate.rate !== null && r.periods[2].winRate.rate > 80, r.periods[2].winRate);
  check("preventable share fell to zero", r.periods[0].preventableSharePct === 100 && r.periods[2].preventableSharePct === 0, r.periods.map((p) => p.preventableSharePct));
  check("the verdict says improving", r.verdict.level === "improving", r.verdict);
  check("and the headline names 近期 beating 前期", r.verdict.headline.includes("近期") && r.verdict.headline.includes("前期"), r.verdict.headline);
  const wr = r.learning.find((d) => d.metric === "勝率");
  check("the 勝率 delta is positive and marked better", wr?.better === true && (wr.delta ?? 0) > 0, wr);
  const prev = r.learning.find((d) => d.metric === "可預防虧損占比");
  check("a falling preventable share is marked better", prev?.better === true && (prev.delta ?? 0) < 0, prev);
  check("rolling window is 10 under 30 resolved", r.rollingWindow === 10 && r.rolling.length === 18 - 10 + 1, [r.rollingWindow, r.rolling.length]);
  check("rolling series ends above where it started", r.rolling[r.rolling.length - 1].winRate > r.rolling[0].winRate, r.rolling);
  const line = performanceLine(r);
  check("the digest line carries rate, interval and verdict", line !== null && line.includes("95% 區間") && line.includes("學習有成效"), line);
}

// ── a book that got worse says so ─────────────────────────────────
{
  seq = 0;
  const early = [win(2), win(2), win(2), loss(-1), win(2), win(2)];
  const late = [loss(-2), loss(-2), win(1), loss(-2), loss(-2), loss(-2)];
  const r = computePerformance([...early, ...late]);
  check("two periods when only 12 resolved", r.periods.length === 2, r.periods.length);
  check("the verdict says worsening", r.verdict.level === "worsening", r.verdict);
  check("and points at the preventable share first", r.verdict.detail.includes("可預防虧損占比"));
  check("80% is out of reach on this sample", r.targetNote.includes("不在可能範圍內"), r.targetNote);
  check("and the note offers the breakeven line instead", r.targetNote.includes("正期望"), r.targetNote);
}

// ── control group: tightened vs untouched ─────────────────────────
{
  seq = 0;
  const marker = intervenedMarker(["S2", "S3", "S2", null]);
  check("the marker lists unique tags", marker === "[已干涉 S2,S3]", marker);
  check("no tags, no marker", intervenedMarker([null, undefined]) === "");
  const tightened = row({ review_note: `[自動追蹤][情境 中] ${marker} 觸及停利`, result: "win", pnl_pct: 2 });
  check("the marker is recognised in a note", isIntervened(tightened));
  check("and absent otherwise", !isIntervened(row()));
  const rows = [
    ...Array.from({ length: 5 }, () => row({ review_note: `[自動追蹤]${marker} 觸及停利`, result: "win", pnl_pct: 2, stop_reason_tag: null })),
    row({ review_note: `[自動追蹤]${marker} 觸及停損`, result: "loss", pnl_pct: -1 }),
    ...Array.from({ length: 3 }, () => win(1)),
    ...Array.from({ length: 3 }, () => loss(-1.5)),
  ];
  const r = computePerformance(rows);
  check("the split exists", r.intervention !== null);
  check("tightened trades counted", r.intervention?.with.trades === 6, r.intervention?.with);
  check("untouched trades counted", r.intervention?.without.trades === 6, r.intervention?.without);
  check("and the note says the tightening paid", r.intervention?.note.includes("有在賺錢") === true, r.intervention?.note);
  check("no tightened trades, no split", computePerformance([win(), loss()]).intervention === null);
}

report("performance");

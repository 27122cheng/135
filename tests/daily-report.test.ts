import { check, report } from "./_harness";
import { buildDailyReport, dayIn, periodBounds, reportText } from "@/lib/journal/daily-report";
import { reportSvg } from "@/lib/journal/report-svg";
import type { JournalEntry } from "@/types/journal";

/** 盤中策略與交易紀錄 — the daily report from the journal. */

let seq = 0;
function row(over: Partial<JournalEntry>): JournalEntry {
  seq++;
  return {
    id: `j-${seq}`, signal_id: null, symbol: "XAUUSD", direction: "long", grade: "A",
    entry_price: 3943, exit_price: 3956, result: "win", pnl_pct: 0.33,
    closed_at: "2026-11-03T06:00:00.000Z", stop_reason_tag: null, severity: null,
    review_note: "[自動追蹤] 觸及停利 3956，未經人工複核。", created_at: "2026-11-03T06:00:00.000Z", ...over,
  };
}

check("UTC 18:00 on the 3rd is the 4th in Taipei", dayIn("2026-11-03T18:00:00.000Z", "Asia/Taipei") === "2026-11-04");
check("a week runs Monday to Sunday", JSON.stringify(periodBounds("2026-11-04", "week")) === JSON.stringify({ from: "2026-11-02", to: "2026-11-08" }), periodBounds("2026-11-04", "week"));
check("a month runs 1st to last", periodBounds("2026-02-10", "month").to === "2026-02-28");

const entries = [
  row({}),
  row({ direction: "short", entry_price: 3963, exit_price: 3948, pnl_pct: 0.38 }),
  row({ symbol: "WTI", entry_price: 95.2, exit_price: 96.3, pnl_pct: 1.16 }),
  row({ symbol: "WTI", direction: "short", entry_price: 96.2, exit_price: 96.6, result: "loss", pnl_pct: -0.42, stop_reason_tag: "S2", review_note: "[自動追蹤] 觸及停損 96.6" }),
  row({ result: "breakeven", exit_price: 3944, pnl_pct: 0.02, review_note: "[自動追蹤] 保本出場 3944" }),
  row({ review_note: "[自動追蹤][參考價位紙上追蹤] 觸及停利 3956" }),
  row({ closed_at: "2026-11-01T06:00:00.000Z", result: "loss", exit_price: 3930, pnl_pct: -0.33, review_note: "[自動追蹤] 觸及停損 3930" }),
];
const labels = { XAUUSD: "現貨黃金", WTI: "美國原油" };

{
  const r = buildDailyReport(entries, { date: "2026-11-03", labels });
  check("the day holds the five real rows", r.summary.trades === 5, r.summary);
  check("paper is listed but not counted", r.paperCount === 1 && r.rows.filter((x) => x.paper).length === 1 && r.summary.trades === 5);
  check("breakeven is out of the win rate", r.summary.wins === 3 && r.summary.losses === 1 && r.summary.winRate === 75, r.summary);
  check("the interval rides along", r.summary.winRateLow !== null && r.summary.winRateLow < 40, r.summary);
  check("profit factor is gross win ÷ gross loss", r.summary.profitFactor !== null && Math.abs(r.summary.profitFactor - (0.33 + 0.38 + 1.16) / 0.42) < 0.05, r.summary.profitFactor);
  check("points are signed by direction", r.rows.find((x) => x.direction === "short" && x.symbol === "XAUUSD")?.points === 15, r.rows);
  check("per-symbol points split wins and losses", r.bySymbol.find((b) => b.symbol === "WTI")?.lossPoints === -0.4 && r.bySymbol.find((b) => b.symbol === "XAUUSD")?.winPoints === 29, r.bySymbol);
  check("labels resolve", r.rows[0].label === "現貨黃金" || r.rows[0].label === "美國原油");
  check("historical covers the other day too", r.historical.trades === 6, r.historical);
  check("a small sample is called a sample", r.notes.some((n) => n.includes("手感")), r.notes);
  const text = reportText(r);
  check("text carries the four numbers", text.includes("有效記錄 5 筆") && text.includes("勝率 75%") && text.includes("盈虧比"), text);
  const svg = reportSvg(r);
  check("svg is a document with every real row", svg.startsWith("<svg") && (svg.match(/<rect x="30"/g) ?? []).length >= 5, svg.length);
  check("svg escapes nothing dangerous", !svg.includes("<script"));
}

{
  const empty = buildDailyReport(entries, { date: "2026-10-01", labels });
  check("an empty day is honest", empty.summary.trades === 0 && empty.summary.winRate === null && empty.bySymbol.length === 0);
  check("empty text says so", reportText(empty).includes("0 筆結算"));
  check("empty svg still renders", reportSvg(empty).includes("本期沒有結算"));
  const week = buildDailyReport(entries, { date: "2026-11-03", range: "week", labels });
  check("a week includes the 1st? no — Nov 1 is a Sunday of the prior week", week.summary.trades === 5, week.summary);
  const month = buildDailyReport(entries, { date: "2026-11-03", range: "month", labels });
  check("the month includes both days", month.summary.trades === 6, month.summary);
}

report("daily-report");

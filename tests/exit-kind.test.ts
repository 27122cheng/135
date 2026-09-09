import { check, report } from "./_harness";
import { exitKindAdvice, exitKindOf, splitStreams, summariseExitKinds } from "@/lib/journal/exit-kind";
import type { JournalEntry } from "@/types/journal";

/** 出場方式 — every ending counted, early exits included, with advice. */

let seq = 0;
function row(over: Partial<JournalEntry> = {}): JournalEntry {
  seq++;
  return {
    id: `j-${seq}`, signal_id: null, symbol: "XAUUSD", direction: "long", grade: "B",
    entry_price: 2000, exit_price: 1980, result: "loss", pnl_pct: -1,
    closed_at: `2026-09-${String((seq % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    stop_reason_tag: null, severity: null, review_note: "[自動追蹤] 觸及停損 1980",
    created_at: "2026-09-01T00:00:00.000Z", ...over,
  };
}
const kinds = {
  stop: row(),
  target: row({ result: "win", pnl_pct: 3, review_note: "[自動追蹤] 觸及停利 2060，未經人工複核。" }),
  scale: row({ result: "win", pnl_pct: 2, review_note: "[自動追蹤] 分批止盈：先在 2060 平一半落袋" }),
  be: row({ result: "breakeven", pnl_pct: 0.05, review_note: "[自動追蹤] 保本出場 2001（0.05%）" }),
  structure: row({ pnl_pct: -0.6, review_note: "[自動追蹤] 結構翻轉出場 1988（虧損 -0.6%）" }),
  thesis: row({ result: "win", pnl_pct: 0.8, review_note: "[自動追蹤] 論點失效出場 2016（獲利 0.8%）" }),
  manual: row({ review_note: "我自己記的" }),
  paperStop: row({ review_note: "[自動追蹤][參考價位紙上追蹤] 觸及停損 1980" }),
};

check("stop", exitKindOf(kinds.stop) === "stop");
check("target", exitKindOf(kinds.target) === "target");
check("scale-out", exitKindOf(kinds.scale) === "scale_out");
check("breakeven", exitKindOf(kinds.be) === "breakeven");
check("structure exit", exitKindOf(kinds.structure) === "structure");
check("thesis exit", exitKindOf(kinds.thesis) === "thesis");
check("a hand-written row is manual", exitKindOf(kinds.manual) === "manual");
check("a classified early exit keeps its kind",
  exitKindOf(row({ review_note: "[自動追蹤] 結構翻轉出場 1988（虧損 -0.6%），未觸及停損停利：… 分類 S2（由規則判定）" })) === "structure");

{
  const s = splitStreams(Object.values(kinds));
  check("paper rows go to the paper stream", s.paper.length === 1 && s.paper[0] === kinds.paperStop);
  check("real stream excludes paper and manual", s.real.length === 6);
}

{
  const stats = summariseExitKinds(Object.values(kinds).filter((k) => k !== kinds.paperStop));
  const by = Object.fromEntries(stats.map((s) => [s.kind, s]));
  check("every kind observed gets a row", stats.length === 7, stats.map((s) => s.kind));
  check("target row: one win, 100%", by.target.wins === 1 && by.target.winRate === 100);
  check("breakeven row: counted, not in the win rate", by.breakeven.breakeven === 1 && by.breakeven.winRate === null);
  check("structure row carries its loss", by.structure.losses === 1 && by.structure.totalPnlPct === -0.6);
  check("shares add to 100", Math.round(stats.reduce((n, s) => n + s.sharePct, 0)) === 100);
  check("reading order: target first, manual last", stats[0].kind === "target" && stats[stats.length - 1].kind === "manual");
}

{
  check("fewer than five trades → no advice", exitKindAdvice(summariseExitKinds([kinds.stop, kinds.target])).length === 0);
  const structural = summariseExitKinds([
    kinds.target, kinds.stop,
    row({ pnl_pct: -0.5, review_note: "[自動追蹤] 結構翻轉出場 1990" }),
    row({ pnl_pct: -0.7, review_note: "[自動追蹤] 結構翻轉出場 1986" }),
    row({ result: "win", pnl_pct: 0.4, review_note: "[自動追蹤] 結構翻轉出場 2008" }),
  ]);
  const adv = exitKindAdvice(structural);
  check("losing structure exits earn a line", adv.some((a) => a.kind === "structure"), adv);
  check("that says what to check next", adv.find((a) => a.kind === "structure")?.detail.includes("ER(20)") === true);
  const scratchy = summariseExitKinds([
    kinds.target, kinds.stop,
    row({ result: "breakeven", pnl_pct: 0, review_note: "[自動追蹤] 保本出場 2000" }),
    row({ result: "breakeven", pnl_pct: 0.1, review_note: "[自動追蹤] 保本出場 2002" }),
    row({ result: "breakeven", pnl_pct: -0.1, review_note: "[自動追蹤] 保本出場 1998" }),
  ]);
  check("more scratches than targets earn a line", exitKindAdvice(scratchy).some((a) => a.kind === "breakeven"));
  const stoppy = summariseExitKinds([kinds.target, kinds.stop, row(), row(), row()]);
  check("a majority of stop-outs earns a line pointing at the tag distribution",
    exitKindAdvice(stoppy).some((a) => a.kind === "stop" && a.detail.includes("停損原因分布")));
  check("no pattern, no advice", exitKindAdvice(summariseExitKinds([kinds.target, kinds.target, kinds.scale, kinds.stop, kinds.thesis])).length === 0);
}

report("exit kinds");

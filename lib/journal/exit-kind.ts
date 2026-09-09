import type { JournalEntry } from "@/types/journal";
import { AUTO_MARKER, PAPER_MARKER } from "./markers";

/**
 * 出場方式 — how each resolved trade actually ended, and what that mix says.
 *
 * The track record answers "did it pay"; the stop taxonomy answers "why did
 * the stop get hit". Between them sat a hole: a trade closed early by the
 * structure rule, or by its thesis dying, or scratched at breakeven, was
 * counted in the win rate and then never looked at again — no bucket, no
 * share, no lesson. The operator's standing instruction is that every
 * ending (提早止損、止盈、止損) is part of the summary, so this is the table
 * that lists them side by side with what each one cost or paid.
 *
 * The kind is read from the note the writer left (auto-log.ts). A hand-
 * written row that names none of the phrases is `manual`.
 */

export type ExitKind =
  | "stop"       // 觸及停損
  | "target"     // 觸及停利（全部出場）
  | "scale_out"  // 分批止盈後收尾
  | "breakeven"  // 保本出場（停損已移到成本附近）
  | "structure"  // 結構翻轉，提早出場
  | "thesis"     // 論點失效，提早出場
  | "manual";    // 人工記錄

export const EXIT_KIND_LABELS: Record<ExitKind, string> = {
  stop: "觸及停損",
  target: "觸及停利",
  scale_out: "分批止盈後收尾",
  breakeven: "保本出場",
  structure: "結構翻轉提早出場",
  thesis: "論點失效提早出場",
  manual: "人工記錄",
};

/** The early exits — closed by a rule before stop or target. */
export const EARLY_EXIT_KINDS: ReadonlySet<ExitKind> = new Set<ExitKind>(["structure", "thesis"]);

export function exitKindOf(entry: JournalEntry): ExitKind {
  const note = entry.review_note ?? "";
  if (!note.includes(AUTO_MARKER)) return "manual";
  if (note.includes("分批止盈")) return "scale_out";
  if (note.includes("論點失效出場")) return "thesis";
  if (note.includes("結構翻轉出場")) return "structure";
  if (note.includes("保本出場")) return "breakeven";
  if (note.includes("觸及停利")) return "target";
  if (note.includes("觸及停損")) return "stop";
  return "manual";
}

export interface ExitKindStat {
  kind: ExitKind;
  label: string;
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  /** Share of all trades in the stream, in percent. */
  sharePct: number;
  winRate: number | null;
  totalPnlPct: number;
  avgPnlPct: number | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

const ORDER: ExitKind[] = ["target", "scale_out", "stop", "breakeven", "structure", "thesis", "manual"];

/** One row per kind actually observed, in a fixed reading order. */
export function summariseExitKinds(entries: JournalEntry[]): ExitKindStat[] {
  const by = new Map<ExitKind, JournalEntry[]>();
  for (const e of entries) {
    const k = exitKindOf(e);
    by.set(k, [...(by.get(k) ?? []), e]);
  }
  return ORDER.filter((k) => by.has(k)).map((kind) => {
    const list = by.get(kind)!;
    const wins = list.filter((e) => e.result === "win").length;
    const losses = list.filter((e) => e.result === "loss").length;
    const breakeven = list.length - wins - losses;
    const resolved = wins + losses;
    const total = list.reduce((s, e) => s + e.pnl_pct, 0);
    return {
      kind,
      label: EXIT_KIND_LABELS[kind],
      trades: list.length,
      wins,
      losses,
      breakeven,
      sharePct: entries.length > 0 ? r2((list.length / entries.length) * 100) : 0,
      winRate: resolved > 0 ? r2((wins / resolved) * 100) : null,
      totalPnlPct: r2(total),
      avgPnlPct: list.length > 0 ? r2(total / list.length) : null,
    };
  });
}

/** The two streams the rest of the review keeps apart. */
export function splitStreams(entries: JournalEntry[]): { real: JournalEntry[]; paper: JournalEntry[] } {
  const paper = entries.filter((e) => e.review_note?.includes(PAPER_MARKER));
  const real = entries.filter(
    (e) => e.review_note?.includes(AUTO_MARKER) && !e.review_note?.includes(PAPER_MARKER),
  );
  return { real, paper };
}

export interface ExitAdvice {
  kind: ExitKind;
  title: string;
  detail: string;
  basedOn: string;
}

/**
 * What the mix of endings says to do next. Rule-generated from the same
 * stats, and only where a pattern is actually there — advice about an
 * ending that never happened is noise. Thresholds are counts, not shares,
 * because a share of three trades is not a pattern.
 */
export function exitKindAdvice(stats: ExitKindStat[], minTrades = 5): ExitAdvice[] {
  const total = stats.reduce((n, s) => n + s.trades, 0);
  if (total < minTrades) return [];
  const get = (k: ExitKind) => stats.find((s) => s.kind === k);
  const out: ExitAdvice[] = [];

  const structure = get("structure");
  if (structure && structure.trades >= 3 && structure.losses > structure.wins) {
    out.push({
      kind: "structure",
      title: "結構翻轉提早出場多半在虧損",
      detail:
        "反向 CHoCH 在停損前先來，代表進場時離結構轉折太近、或是趨勢已在末端。" +
        "下一筆看兩件事：進場區是否在最近一個確認 swing 之後才建立，以及 D1 的 ER(20) 是否還在趨勢區。" +
        "這類出場的虧損已按 S1–S8 分類並計入干涉規則，不會因為不是碰到停損而被漏掉。",
      basedOn: `${structure.trades} 筆結構翻轉出場，${structure.losses} 虧 ${structure.wins} 勝，合計 ${structure.totalPnlPct}%`,
    });
  }
  const thesis = get("thesis");
  if (thesis && thesis.trades >= 3 && thesis.losses > thesis.wins) {
    out.push({
      kind: "thesis",
      title: "論點失效出場多半在虧損",
      detail:
        "行情性質在持倉期間就變了：順勢回踩的單遇到盤整，或區間反轉的單遇到突破。" +
        "這是進場時 regime 判斷過於樂觀的訊號 —— 過渡帶（ER 接近門檻）的訊號應以半倉處理，或等結構明確再進。",
      basedOn: `${thesis.trades} 筆論點失效出場，${thesis.losses} 虧 ${thesis.wins} 勝，合計 ${thesis.totalPnlPct}%`,
    });
  }
  const be = get("breakeven");
  const target = get("target");
  const scaled = get("scale_out");
  const paid = (target?.trades ?? 0) + (scaled?.trades ?? 0);
  if (be && be.trades >= 3 && be.trades >= paid) {
    out.push({
      kind: "breakeven",
      title: "保本出場比停利多",
      detail:
        "行情走了 2R 又全數回吐，是常見的「小獲利或打平」輪廓。" +
        "這不是方向錯，是目標與移停的節奏：分批止盈只在目標 ≥2R 時啟用，若多數目標不足 2R，等於在放棄可兌現的那一半。" +
        "檢查停利是否被最近的壓力壓得太近，或是保本移停是否在 2R 前就被結構移停搶先。",
      basedOn: `${be.trades} 筆保本出場，對比停利 ${paid} 筆`,
    });
  }
  const stop = get("stop");
  if (stop && stop.trades >= 3 && stop.trades / total >= 0.5) {
    out.push({
      kind: "stop",
      title: "超過一半的交易以停損結束",
      detail:
        "停損比例本身不是問題，賠率才是：勝率低於「損益兩平需 x%」才是虧損。" +
        "先看停損原因分布 —— S2、S3 佔多數表示是進場位置與緩衝的問題，干涉規則已在收窄區間與放寬緩衝；S1、S7 佔多數表示是方向，該減少逆勢與逆基本面的單。",
      basedOn: `${stop.trades} 筆停損，佔 ${stop.sharePct}%`,
    });
  }
  return out;
}

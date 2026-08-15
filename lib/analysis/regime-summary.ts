import type { BiasItem } from "@/types/signal";

/**
 * 市況摘要 — the four readings a trader decides on, pulled out of the flat
 * factor list for the card at the top of the page.
 *
 * Pure and defensive on purpose. The card renders signals stored by *older
 * builds of the analyzer*, whose rows can be missing any field the current
 * type claims — that exact mismatch once took the detail page to a black
 * screen reading "Application error: a client-side exception has occurred".
 * So every input is treated as unknown-shaped: a missing list, a null item,
 * an item with no `factor`, a `weight` that is a string. Nothing here throws;
 * an unrecognisable input produces an empty summary and the card renders
 * nothing rather than half a card and a stack trace.
 *
 * Selection matches on what the analyzers actually emit rather than on
 * position in the list, so an analyzer that stops emitting one reading
 * leaves a hole instead of mislabelling whatever moved into its slot.
 */

export type RegimeTone = "long" | "short" | "neutral";

export interface RegimeCell {
  /** Headline word — already resolved, so the view does no interpreting. */
  label: string;
  tone: RegimeTone;
  /** Second line, or null when there is nothing honest to add. */
  detail: string | null;
}

export interface RegimeBanner {
  factor: string;
  evidence: string;
  tone: RegimeTone;
}

export interface RegimeSummary {
  structure: RegimeCell;
  efficiency: RegimeCell;
  weekly: RegimeCell;
  emaStack: RegimeCell;
  /** 假突破 — the one weight-2 price-action verdict, when present. */
  falseBreak: RegimeBanner | null;
  /** Unfilled gaps — position information, never a direction. */
  gaps: RegimeBanner | null;
  /** False when nothing was recognised: the card should not render at all. */
  hasAny: boolean;
}

const EMPTY: RegimeCell = { label: "—", tone: "neutral", detail: null };

function toneOf(item: unknown): RegimeTone {
  const d = (item as { direction?: unknown } | null)?.direction;
  return d === "long" || d === "short" ? d : "neutral";
}

function factorOf(item: unknown): string {
  const f = (item as { factor?: unknown } | null)?.factor;
  return typeof f === "string" ? f : "";
}

function evidenceOf(item: unknown): string {
  const e = (item as { evidence?: unknown } | null)?.evidence;
  return typeof e === "string" ? e : "";
}

function weightOf(item: unknown): number {
  const w = (item as { weight?: unknown } | null)?.weight;
  return typeof w === "number" && Number.isFinite(w) ? w : 0;
}

export function summariseRegime(items: readonly BiasItem[] | null | undefined): RegimeSummary {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const tech = list.filter(
    (b) => (b as { dimension?: unknown })?.dimension === "技術面",
  );
  const find = (re: RegExp) => tech.find((b) => re.test(factorOf(b)));

  const structure = find(/D1 結構/);
  const efficiency = find(/趨勢效率比/);
  const weekly = find(/^W1 週線/);
  // Anchored to "D1 EMA…" / "D1 主趨勢…" (the coarse-grained tier), not a
  // bare /EMA/: the weekly factor's own text mentions 週線 EMA20, and a loose
  // match put the weekly reading in the moving-average cell — the exact class
  // of mislabelling this module's match-what-is-emitted rule exists to avoid.
  const emaStack = find(/^D1 (EMA|主趨勢)/);
  const falseBreak = find(/假跌破|假突破回落/);
  const gaps = find(/未回補跳空/);

  const structureCell: RegimeCell = structure
    ? {
        label:
          toneOf(structure) === "long"
            ? "上升結構"
            : toneOf(structure) === "short"
              ? "下降結構"
              : "結構混合",
        tone: toneOf(structure),
        detail: /成熟趨勢/.test(factorOf(structure))
          ? "成熟（連兩段同向）"
          : /單段趨勢/.test(factorOf(structure))
            ? "單段（僅最近一段）"
            : null,
      }
    : EMPTY;

  const erMatch = /ER\(20\)=([\d.]+)/.exec(factorOf(efficiency));
  const efficiencyCell: RegimeCell = efficiency
    ? {
        label: erMatch?.[1] ?? "—",
        tone: "neutral",
        detail: /趨勢行進中/.test(factorOf(efficiency))
          ? "趨勢行進中"
          : /盤整/.test(factorOf(efficiency))
            ? "盤整（趨勢票已降權）"
            : /過渡帶/.test(factorOf(efficiency))
              ? "過渡帶"
              : null,
      }
    : EMPTY;

  const weeklyCell: RegimeCell = weekly
    ? {
        label:
          toneOf(weekly) === "long" ? "偏多" : toneOf(weekly) === "short" ? "偏空" : "不明",
        tone: toneOf(weekly),
        detail: "W1 EMA20 ＋ 週線擺動",
      }
    : { ...EMPTY, detail: "資料不足" };

  const emaCell: RegimeCell = emaStack
    ? {
        label:
          toneOf(emaStack) === "long" ? "多頭" : toneOf(emaStack) === "short" ? "空頭" : "糾結",
        tone: toneOf(emaStack),
        detail: weightOf(emaStack) > 0 ? `權重 ×${weightOf(emaStack)}` : null,
      }
    : EMPTY;

  const banner = (item: BiasItem | undefined): RegimeBanner | null =>
    item ? { factor: factorOf(item), evidence: evidenceOf(item), tone: toneOf(item) } : null;

  return {
    structure: structureCell,
    efficiency: efficiencyCell,
    weekly: weeklyCell,
    emaStack: emaCell,
    falseBreak: banner(falseBreak),
    gaps: banner(gaps),
    hasAny: Boolean(structure || efficiency || weekly || emaStack || falseBreak || gaps),
  };
}

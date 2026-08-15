import { check, report } from "./_harness";
import { summariseRegime } from "@/lib/analysis/regime-summary";
import type { BiasItem } from "@/types/signal";

/**
 * 市況摘要 — what the card at the top of the detail page reads from.
 *
 * Half these cases are malformed on purpose. This component renders rows
 * stored by older builds of the analyzer, and the last time a stored row
 * reached a renderer that assumed the current shape, the detail page went to
 * a black screen reading "Application error: a client-side exception has
 * occurred". Nothing in here may throw, whatever it is handed.
 */

function item(over: Partial<BiasItem>): BiasItem {
  return {
    dimension: "技術面",
    factor: "f",
    direction: "neutral",
    weight: 0,
    evidence: "e",
    source: "s",
    ...over,
  } as BiasItem;
}

// ── a full house ──────────────────────────────────────────────────
{
  const r = summariseRegime([
    item({
      factor: "D1 結構 HH/HL（連兩段同向，成熟趨勢）：高點 100→110→120，低點 90→95→100",
      direction: "long",
      weight: 2,
    }),
    item({ factor: "D1 趨勢效率比 ER(20)=0.42 —— 趨勢行進中" }),
    item({ factor: "W1 週線偏多：價格在週線 EMA20 之上且週線結構 HH/HL", direction: "long", weight: 1 }),
    item({ factor: "D1 EMA 多頭排列：價格120 > EMA20 > EMA50 > EMA200", direction: "long", weight: 2 }),
    item({
      factor: "D1 假跌破反轉（Spring）：影線刺破 D1 前低 98.00 後收回其上",
      direction: "long",
      weight: 2,
      evidence: "最低 97.20 跌破 98.00",
    }),
    item({ factor: "D1 有 2 個未回補跳空缺口，最近的在下方 100.50–103.00（2026-08-11）" }),
    // Noise that must not be mistaken for any of the above.
    item({ factor: "D1 RSI(14) = 62，位於中性區" }),
    item({ dimension: "基本面", factor: "DXY 近期走弱", direction: "long", weight: 1 }),
  ]);

  check("the card renders when anything is recognised", r.hasAny);
  check("structure reads its direction", r.structure.label === "上升結構" && r.structure.tone === "long", r.structure);
  check("and its maturity tier", r.structure.detail?.includes("成熟") === true, r.structure.detail);
  check("the efficiency ratio is extracted as a number", r.efficiency.label === "0.42", r.efficiency);
  check("with its regime word", r.efficiency.detail === "趨勢行進中", r.efficiency.detail);
  check("the weekly cell reads long", r.weekly.label === "偏多" && r.weekly.tone === "long", r.weekly);
  check("the EMA cell carries its weight", r.emaStack.detail === "權重 ×2", r.emaStack);
  check("the Spring is promoted to a banner",
    r.falseBreak?.tone === "long" && r.falseBreak.factor.includes("假跌破"), r.falseBreak);
  check("gaps come through as position info", r.gaps?.factor.includes("未回補跳空") === true, r.gaps);
  // The one thing that must never happen: a fundamental factor in a
  // technical cell.
  check("non-technical factors are ignored", !JSON.stringify(r).includes("DXY"));
}

// ── the chop discount is visible ──────────────────────────────────
{
  const r = summariseRegime([
    item({ factor: "D1 趨勢效率比 ER(20)=0.11 —— 盤整（趨勢票已降權）" }),
    item({ factor: "D1 結構 LH/LL（僅最近一段，單段趨勢）：…（盤整環境 ER=0.11，權重降一級）", direction: "short", weight: 1 }),
  ]);
  check("chop is named", r.efficiency.detail?.includes("盤整") === true, r.efficiency);
  check("a single-leg trend says so", r.structure.detail?.includes("單段") === true, r.structure);
  check("and reads short", r.structure.tone === "short");
}

// ── an Upthrust is the mirror ─────────────────────────────────────
{
  const r = summariseRegime([
    item({
      factor: "H4 假突破回落（Upthrust）：影線刺穿 D1 前高 106.00 後收回其下",
      direction: "short",
      weight: 2,
    }),
  ]);
  check("an Upthrust banners short", r.falseBreak?.tone === "short", r.falseBreak);
  check("and the card renders for it alone", r.hasAny);
}

// ── nothing recognised means no card ──────────────────────────────
{
  const r = summariseRegime([item({ factor: "D1 RSI(14) = 50，位於中性區" })]);
  check("an unrecognised set renders nothing", !r.hasAny);
  check("but still returns whole cells", r.structure.label === "—" && r.weekly.detail === "資料不足");
}

// ── malformed input must not throw ────────────────────────────────
//
// Each of these is a shape a row written by an older build can genuinely
// have. The assertion is simply that we get a summary back.
{
  const junk: unknown[] = [
    undefined,
    null,
    [],
    "not an array",
    42,
    [null, undefined],
    [{}],
    [{ dimension: "技術面" }],
    [{ dimension: "技術面", factor: null }],
    [{ dimension: "技術面", factor: "D1 結構 HH/HL", direction: "sideways", weight: "2" }],
    [{ dimension: "技術面", factor: "D1 趨勢效率比 ER(20)=不是數字 —— 盤整" }],
    [{ dimension: null, factor: "D1 結構 HH/HL" }],
  ];
  let threw: string | null = null;
  let rendered = 0;
  for (const input of junk) {
    try {
      const r = summariseRegime(input as never);
      if (r.hasAny) rendered++;
      // Every cell must exist even when nothing matched, or the view's
      // property access is the next crash.
      if (!r.structure || !r.efficiency || !r.weekly || !r.emaStack) {
        threw = `missing cell for ${JSON.stringify(input)}`;
      }
    } catch (err) {
      threw = `${JSON.stringify(input)} → ${err instanceof Error ? err.message : String(err)}`;
      break;
    }
  }
  check("no malformed input throws", threw === null, threw);
  check("a factor with a garbled ER still yields a cell",
    summariseRegime([
      { dimension: "技術面", factor: "D1 趨勢效率比 ER(20)=不是數字 —— 盤整" },
    ] as never).efficiency.label === "—");
  check("an unparseable direction falls back to neutral",
    summariseRegime([
      { dimension: "技術面", factor: "D1 結構 HH/HL", direction: "sideways" },
    ] as never).structure.tone === "neutral");
  check("the malformed rows that did match still rendered", rendered > 0);
}

report("市況摘要");

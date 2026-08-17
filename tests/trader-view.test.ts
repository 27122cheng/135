import { check, report } from "./_harness";
import { buildTraderView, macroBoard } from "@/lib/analysis/trader-view";
import type { BiasItem, TradeSignal } from "@/types/signal";

/**
 * 頂級交易員視角.
 *
 * Two properties matter more than the prose. First, every claim must trace to
 * evidence the pipeline already produced — a section that invents conviction
 * is worse than no section. Second, the invalidation line is never optional:
 * it is the field amateurs omit and the one that decides whether a view
 * survives contact with the market, so no input may produce a view without
 * one. And, as always, it renders rows written by older builds, so nothing
 * here may throw on a malformed signal.
 */

function item(over: Partial<BiasItem>): BiasItem {
  return {
    dimension: "基本面",
    factor: "f",
    direction: "neutral",
    weight: 0,
    evidence: "e",
    source: "s",
    ...over,
  } as BiasItem;
}

function signal(over: Partial<TradeSignal> = {}): TradeSignal {
  return {
    symbol: "XAUUSD",
    direction: "long",
    grade: "B",
    bias_items: [],
    data_gaps: [],
    trade_plan: { stance: "wait", entry: null, stop_loss: null, take_profit: null },
    plan_backtest: null,
    ...over,
  } as unknown as TradeSignal;
}

// ── an entered plan reads like a position ─────────────────────────
{
  const v = buildTraderView(
    signal({
      grade: "A",
      direction: "long",
      trade_plan: {
        stance: "enter",
        entry: 4300,
        stop_loss: 4265,
        take_profit: 4380,
        risk_reward: 2.3,
        entry_reason: "等回踩 D1 前低",
        add_ons: [{ sequence: 1 }],
      } as never,
      stop_loss: { structure: "D1 前低 @ 4270" } as never,
      plan_backtest: {
        hitRate: 0.72, resolved: 40, wins: 29, expectancyR: 0.65, costPct: 0.02,
      } as never,
      bias_items: [
        item({ dimension: "技術面", factor: "D1 結構 HH/HL（連兩段同向，成熟趨勢）", direction: "long", weight: 2 }),
        item({ dimension: "技術面", factor: "D1 趨勢效率比 ER(20)=0.44 —— 趨勢行進中" }),
        item({ dimension: "技術面", factor: "W1 週線偏多：…", direction: "long", weight: 1 }),
        item({ factor: "實質利率下滑", direction: "long", weight: 2 }),
        item({ dimension: "籌碼面", factor: "COT 非商業淨多單增加", direction: "long", weight: 1 }),
      ],
    }),
  );

  check("the headline states the actual position", v.headline.includes("4300") && v.headline.includes("多單"), v.headline);
  check("with the stop and target", v.headline.includes("4265") && v.headline.includes("4380"));
  check("conviction follows the grade", v.conviction === "high");
  check("the thesis cites the regime", v.thesis.some((t) => t.includes("上升結構")), v.thesis);
  check("and the weekly agreement", v.thesis.some((t) => t.includes("週線")), v.thesis);
  check("and the measured hit rate", v.thesis.some((t) => t.includes("72%")), v.thesis);
  check("execution refuses to chase", v.execution.some((e) => e.includes("不追價")));
  check("sizing is stated as a share of the account",
    v.execution.some((e) => e.includes("1–2%")));
  check("management names the 1R/2R rule", v.execution.some((e) => e.includes("1R")));
  check("add-ons are covered when present", v.execution.some((e) => e.includes("加倉")));
  check("the invalidation names the stop", v.invalidation.includes("4265"), v.invalidation);
  check("and forbids widening it", v.invalidation.includes("不改停損"));
}

// ── standing aside is also a view ─────────────────────────────────
{
  const v = buildTraderView(
    signal({
      grade: "C",
      trade_plan: { stance: "wait", wait_for: "等評等升到 B 以上" } as never,
      bias_items: [
        item({ dimension: "技術面", factor: "D1 趨勢效率比 ER(20)=0.09 —— 盤整（趨勢票已降權）" }),
      ],
    }),
  );
  check("no trade is said plainly", v.headline.includes("不進場"), v.headline);
  check("conviction is low", v.conviction === "low");
  check("waiting has an execution plan too", v.execution.some((e) => e.includes("空手等待")));
  check("chop is named as a risk", v.risks.some((r) => r.includes("盤整")), v.risks);
  check("an invalidation still exists", v.invalidation.length > 0);
}

// ── a tie is stated as a tie ──────────────────────────────────────
{
  const v = buildTraderView(signal({ direction_tie: true } as Partial<TradeSignal>));
  check("cancelling evidence is not dressed up as a view",
    v.headline.includes("互相抵消"), v.headline);
}

// ── the macro board keeps every factor's own side ─────────────────
{
  const board = macroBoard([
    item({ dimension: "基本面", factor: "DXY 走弱", direction: "long", weight: 1 }),
    item({ dimension: "籌碼面", factor: "COT 淨空單擴大", direction: "short", weight: 2 }),
    item({ dimension: "新聞面", factor: "情緒分 0.1", direction: "neutral", weight: 0 }),
    // Technical factors belong to the chart sections, not the macro board.
    item({ dimension: "技術面", factor: "D1 EMA 多頭排列", direction: "long", weight: 2 }),
  ]);
  check("technical factors are excluded", !board.some((m) => m.dimension === "技術面"), board);
  check("each factor keeps its own side",
    board.find((m) => m.name === "DXY 走弱")?.stance === "多" &&
      board.find((m) => m.name === "COT 淨空單擴大")?.stance === "空", board);
  check("non-voting readings are kept and labelled",
    board.find((m) => m.name === "情緒分 0.1")?.weight === 0);
  check("the heaviest sits first", board[0].weight === 2);
}

// ── missing data lowers the claim, not the output ─────────────────
{
  const v = buildTraderView(
    signal({
      data_gaps: ["A 取得失敗", "B 取得失敗", "C 取得失敗，且無可用快取"],
    }),
  );
  check("thin evidence is admitted as a reason to size down",
    v.risks.some((r) => r.includes("降低部位")), v.risks);
}

// ── malformed signals must not throw ──────────────────────────────
{
  const junk: unknown[] = [
    {},
    { bias_items: null, trade_plan: null, data_gaps: null },
    { bias_items: "nope", direction: "sideways" },
    { bias_items: [null, undefined, {}], trade_plan: { stance: "enter" } },
    { trade_plan: { stance: "enter", entry: Number.NaN, stop_loss: null } },
  ];
  let threw: string | null = null;
  for (const input of junk) {
    try {
      const v = buildTraderView(input as TradeSignal);
      if (!v.invalidation || v.execution.length === 0 || v.risks.length === 0) {
        threw = `incomplete view for ${JSON.stringify(input)}`;
      }
    } catch (err) {
      threw = `${JSON.stringify(input)} → ${err instanceof Error ? err.message : String(err)}`;
      break;
    }
  }
  check("no malformed signal throws, and none loses its invalidation", threw === null, threw);
}

report("頂級交易員視角");

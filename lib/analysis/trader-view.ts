import type { BiasItem, TradeSignal } from "@/types/signal";
import { summariseRegime } from "./regime-summary";

/**
 * 頂級交易員視角 — the read a professional would write before touching the
 * order ticket, assembled from what this system already knows.
 *
 * ## Why this is deterministic first, and AI only as enrichment
 *
 * The obvious build is "ask a model to role-play a trader". That fails here
 * for a reason this project has already paid for twice: the free AI tiers run
 * out, and a section that is blank or generic on most loads is worse than no
 * section — it teaches the reader to skip it. Worse, a model asked to sound
 * like a trader will *invent* conviction, and the entire discipline of this
 * codebase is that nothing on screen may claim more than the evidence
 * supports.
 *
 * So this composes the view from facts the pipeline has already established —
 * the regime, the structure, the levels, the factor votes, the backtest — and
 * phrases them the way a desk would. Every sentence traces to a number
 * elsewhere on the card. When the AI narrative is available it appears
 * alongside as commentary, not as the thesis.
 *
 * ## What a professional actually writes down
 *
 * Not a prediction. Four things: what I think, why, what would prove me
 * wrong, and what I do about it. The invalidation line is the one amateurs
 * omit and the one that decides whether a view survives contact with the
 * market — so it is a required field here, never optional prose.
 */

export type MacroStance = "多" | "空" | "中性";

export interface MacroFactor {
  /** The factor as the analyzer named it. */
  name: string;
  stance: MacroStance;
  /** Why it points that way, in the analyzer's own evidence. */
  note: string;
  /** Which dimension it came from — 基本面 / 籌碼面 / 技術面 … */
  dimension: string;
  /** 0 = stated but not voting. */
  weight: number;
}

export interface TraderView {
  /** One sentence: the position I would or would not be in. */
  headline: string;
  conviction: "high" | "medium" | "low";
  /** 為什麼 — one line per layer that has something to say. */
  thesis: string[];
  /** 怎麼做 — entry approach, sizing posture, management. */
  execution: string[];
  /** 什麼會證明我錯 — required, never omitted. */
  invalidation: string;
  /** 風險 — what is most likely to go wrong with this specific read. */
  risks: string[];
  /** 影響市場的宏觀因素, each with its own bull/bear reading. */
  macro: MacroFactor[];
}

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Math.abs(n) < 10 ? n.toFixed(5) : n.toFixed(2);
}

function stanceOf(item: BiasItem): MacroStance {
  return item.direction === "long" ? "多" : item.direction === "short" ? "空" : "中性";
}

/**
 * The macro board: every non-technical factor, each with its own side.
 *
 * Drawn from the bias items rather than re-derived, so a factor cannot say
 * one thing here and another in 全部因子. Sorted by weight so the ones that
 * actually moved the score sit at the top, and weight-0 readings are kept —
 * "we looked at this and it says nothing" is information a trader uses.
 */
export function macroBoard(items: readonly BiasItem[] | null | undefined): MacroFactor[] {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  return list
    .filter((b) => b.dimension !== "技術面")
    .map((b) => ({
      name: typeof b.factor === "string" ? b.factor : "—",
      stance: stanceOf(b),
      note: typeof b.evidence === "string" ? b.evidence : "",
      dimension: typeof b.dimension === "string" ? b.dimension : "—",
      weight: typeof b.weight === "number" ? b.weight : 0,
    }))
    .sort((a, b) => b.weight - a.weight);
}

export function buildTraderView(signal: TradeSignal): TraderView {
  const items = signal.bias_items ?? [];
  const regime = summariseRegime(items);
  const plan = signal.trade_plan;
  const entering = plan?.stance === "enter";
  const long = signal.direction === "long";
  const side = long ? "多" : "空";
  const bt = signal.plan_backtest;

  // ── 結論 ────────────────────────────────────────────────────────
  const headline = entering
    ? `我會在 ${fmt(plan?.entry)} 附近建立${side}單，停損 ${fmt(plan?.stop_loss)}，` +
      `第一目標 ${fmt(plan?.take_profit)}${plan?.risk_reward ? `（風報比 1:${plan.risk_reward}）` : ""}。`
    : signal.direction_tie
      ? "我沒有部位，也沒有偏向 —— 多空證據互相抵消，這種盤面不該有意見。"
      : `我目前不進場。方向上我偏${side}，但條件還沒到我願意付出風險的程度。`;

  const conviction: TraderView["conviction"] =
    signal.grade === "A+" || signal.grade === "A" ? "high" : signal.grade === "B" ? "medium" : "low";

  // ── 為什麼 ──────────────────────────────────────────────────────
  const thesis: string[] = [];

  if (regime.structure.label !== "—") {
    thesis.push(
      `**盤勢**：日線是${regime.structure.label}` +
        (regime.structure.detail ? `（${regime.structure.detail}）` : "") +
        (regime.efficiency.label !== "—"
          ? `，走勢效率 ${regime.efficiency.label}${regime.efficiency.detail ? `——${regime.efficiency.detail}` : ""}`
          : "") +
        "。這決定了我願意用多大的部位，以及要不要相信突破。",
    );
  }
  if (regime.weekly.label !== "—") {
    thesis.push(
      `**大週期**：週線${regime.weekly.label}。` +
        (regime.weekly.tone === regime.structure.tone
          ? "與日線同向 —— 順著這個方向做，回檔是機會而不是警訊。"
          : "與日線不同向 —— 這是逆勢單，我會把部位砍半、目標放近。"),
    );
  }
  if (regime.falseBreak) {
    thesis.push(
      `**關鍵訊號**：${regime.falseBreak.factor}。這是整張圖上我最看重的一件事 ——` +
        "有人在這個價位守住了，而且守住之後價格沒有再回去。",
    );
  }

  const macro = macroBoard(items);
  const macroBulls = macro.filter((m) => m.stance === "多" && m.weight > 0).length;
  const macroBears = macro.filter((m) => m.stance === "空" && m.weight > 0).length;
  if (macroBulls + macroBears > 0) {
    thesis.push(
      `**基本面與籌碼**：${macroBulls} 項偏多、${macroBears} 項偏空` +
        (macroBulls === macroBears
          ? " —— 打平。這種時候我只看價格，宏觀留給下面那張表當背景。"
          : (macroBulls > macroBears) === long
            ? " —— 與我的方向一致，屬於順風而不是理由。"
            : " —— 與我的方向相反。我仍然做價格，但這是我把目標放近的原因。"),
    );
  }

  if (bt?.hitRate != null && bt.resolved >= 10) {
    thesis.push(
      `**這組價位的歷史表現**：同樣的停損／停利距離，在類似格局下 ${bt.resolved} 次中勝 ${bt.wins} 次` +
        `（${Math.round(bt.hitRate * 100)}%${bt.costPct ? `，已扣 ${bt.costPct}% 來回成本` : ""}）。` +
        (bt.expectancyR != null
          ? `期望值 ${bt.expectancyR > 0 ? "+" : ""}${bt.expectancyR}R。`
          : ""),
    );
  }

  // ── 怎麼做 ──────────────────────────────────────────────────────
  const execution: string[] = [];
  if (entering) {
    execution.push(
      `**進場**：不追價。${plan?.entry_reason ?? "在計畫的進場區等回檔"} —— ` +
        "價格自己走過來才做，走不過來就沒有這筆交易。",
    );
    execution.push(
      `**部位**：單筆風險不超過帳戶的 1–2%，用停損距離反推口數，不用固定手數。` +
        (conviction === "high" ? "這筆信心較高，可以用上限。" : "信心中等，用下限。"),
    );
    execution.push(
      "**管理**：獲利 1R 把停損移到成本，2R 之後跟隨結構移動。停損只往有利方向移，絕不放寬。",
    );
    if ((plan?.add_ons?.length ?? 0) > 0) {
      execution.push(
        `**加倉**：有 ${plan?.add_ons.length} 個結構加倉點，每一次加倉都同時收緊停損 —— ` +
          "加碼不能讓整體風險變大，否則就是在贏的時候賭更大。",
      );
    }
  } else {
    execution.push(
      `**現在**：空手等待。${plan?.wait_for ?? "等條件成立"}`,
    );
    execution.push(
      "**要等什麼**：價格回到有結構支撐的位置，而不是等一個更好的故事 —— " +
        "故事會一直有，價位不會。",
    );
  }

  // ── 什麼會證明我錯 ──────────────────────────────────────────────
  const invalidation = entering
    ? `價格收在 ${fmt(plan?.stop_loss)} 之外，代表${signal.stop_loss?.structure ?? "停損所依據的結構"}` +
      `已經不是有效的${long ? "支撐" : "壓力"} —— 那一刻這個看法就結束了，不加碼、不凹單、不改停損。`
    : regime.structure.tone !== "neutral"
      ? `如果${long ? "跌破" : "突破"}日線結構的關鍵${long ? "低點" : "高點"}，我目前的方向偏好就作廢，` +
        "會重新從零評估而不是找理由維持原本的看法。"
      : "在結構出現明確方向之前，我沒有可以被推翻的看法 —— 這本身就是結論。";

  // ── 風險 ────────────────────────────────────────────────────────
  const risks: string[] = [];
  if (regime.efficiency.detail?.includes("盤整")) {
    risks.push("盤整格局：這種環境的假突破最多，任何方向性訊號的可信度都要打折。");
  }
  if (regime.weekly.tone !== "neutral" && regime.weekly.tone !== regime.structure.tone) {
    risks.push("日線與週線不同向：逆著大週期做，容錯空間比順勢單小得多。");
  }
  if (regime.gaps) {
    risks.push(`未回補跳空就在附近 —— 價格常被吸回去測試，可能在到達目標前先繞路。`);
  }
  const actionableGaps = (signal.data_gaps ?? []).filter(
    (g) => typeof g === "string" && /取得失敗|無可用快取/.test(g),
  ).length;
  if (actionableGaps >= 3) {
    risks.push(
      `本次有 ${actionableGaps} 項資料沒取到 —— 我的判斷建立在比平常少的證據上，這本身就是降低部位的理由。`,
    );
  }
  if (risks.length === 0) {
    risks.push("沒有發現額外的結構性風險，但市場永遠有我沒看到的東西 —— 停損照設。");
  }

  return { headline, conviction, thesis, execution, invalidation, risks, macro };
}

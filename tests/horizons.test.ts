import { check, report } from "./_harness";
import {
  DAY_PROFILE,
  SWING_PROFILE,
  buildTradePlan,
  selectSwingVariant,
} from "@/lib/analysis/trade-plan";
import { groupDataGaps } from "@/lib/data-gaps";
import { formatAlert } from "@/lib/notify/alert";
import type { TradeSignal } from "@/types/signal";
import type { Candle } from "@/lib/data-sources/ohlcv";

/**
 * 「大時間框架的交易也需要保留，日線當沖的也要決定」— two horizons on one
 * analysis, neither replacing the other.
 *
 * The invariants: the day profile is the strict one (nearer target, higher
 * hit-rate floor); the swing variant may reach targets the day plan excludes
 * and carries its own backtest numbers; and the swing is levels beside the
 * plan, not a second monitored trade.
 */

// A trending market with real range, so far targets actually resolve.
const candles: Candle[] = Array.from({ length: 400 }, (_, i) => {
  const p = 53000 + i * 6 + Math.sin(i / 7) * 400;
  return {
    time: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(),
    open: p,
    high: p + 260,
    low: p - 260,
    close: p,
    volume: 1000,
  };
});

const base = {
  symbol: "US30",
  direction: "long" as const,
  bias_items: [],
  narrative: "t",
  knownGaps: [],
  grade: "A" as const,
  bias_score: 8,
  entry_structure_score: 5,
  total_score: 13,
  gradeForcesWait: false,
  candles,
  atr: 500,
};

async function main() {
  delete process.env.GEMINI_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  // ── the profiles themselves ─────────────────────────────────────
  {
    check("the day horizon is the strict one",
      DAY_PROFILE.maxTargetAtr < SWING_PROFILE.maxTargetAtr &&
        DAY_PROFILE.minHitRate > SWING_PROFILE.minHitRate,
      { DAY_PROFILE, SWING_PROFILE });
  }

  // ── the swing may reach what the day plan excludes ──────────────
  {
    const menu = {
      ...base,
      entryCandidates: [{ price: 55400, label: "現價" }],
      slCandidates: [{ price: 55000, label: "結構外" }],
      tpCandidates: [
        { price: 56200, label: "近的前高" }, // 1.6×ATR — day territory
        { price: 57300, label: "遠的前高" }, // 3.8×ATR — swing only
      ],
    };
    const day = await buildTradePlan(menu, []);
    check("the day plan stays inside its horizon", day.take_profit === 56200, day.take_profit);

    const swing = selectSwingVariant(menu);
    check("a swing variant exists", swing !== null, swing);
    check("its screens allowed the far target",
      swing !== null && !swing.summary.includes("改用未篩選的組合"), swing?.summary);
    check("it carries its own hit rate", swing?.hit_rate !== undefined, swing);
    check("and names the 30% floor", swing?.summary.includes("30%") === true, swing?.summary);
  }

  // ── the alert carries both, and says which one is tracked ───────
  {
    const signal = {
      symbol: "US30",
      direction: "long",
      grade: "A",
      interventions: [],
      data_gaps: [],
      news_digest: null,
      bias_items: [],
      trade_plan: {
        stance: "enter",
        entry: 55400,
        stop_loss: 55000,
        take_profit: 56200,
        risk_reward: 2,
        summary: "s",
        add_ons: [],
        swing: {
          entry: 55400,
          stop_loss: 54800,
          take_profit: 57300,
          risk_reward: 3.17,
          hit_rate: 0.34,
          summary: "swing",
        },
      },
    } as unknown as TradeSignal;
    const text = formatAlert(signal, "r");
    check("the day plan is labelled 當沖", text.includes("當沖"), text);
    check("the swing levels ride along", text.includes("波段") && text.includes("57300"), text);
    check("and the message says only the day plan is tracked",
      text.includes("只追蹤當沖主計畫"), text);
  }

  // ── declining a swing is a note, not a data gap ─────────────────
  {
    const g = groupDataGaps([
      "本次不提供波段變體：D1 趨勢結構與訊號方向未同向（波段持倉需較大時間框架的趨勢支持）",
    ]);
    check("the no-swing note is informational", g.informational.length === 1 && g.other.length === 0,
      g);
  }

  report("dual horizons");
}

void main();

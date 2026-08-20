import { check, report } from "./_harness";
import {
  DAY_PROFILE,
  SWING_PROFILE,
  REFERENCE_PROFILE,
  effectiveDayProfile,
  meetsProfileFloor,
  profileHitFloor,
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

// A steady trend with real range, steep enough that the managed walk (with
// its breakeven scratches) still banks the moves: both horizons demonstrate
// the expectancy floor, so both genuinely qualify.
const candles: Candle[] = Array.from({ length: 400 }, (_, i) => {
  const p = 53000 + i * 80 + Math.sin(i / 7) * 150;
  return {
    time: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(),
    open: p,
    high: p + 260,
    low: p - 260,
    close: p,
    volume: 1000,
  };
});
const LAST = candles[candles.length - 1].close;

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
  atr: 700,
};

async function main() {
  delete process.env.GEMINI_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  // ── the profiles themselves ─────────────────────────────────────
  {
    check("the day horizon reaches less far",
      DAY_PROFILE.maxTargetAtr < SWING_PROFILE.maxTargetAtr,
      { DAY_PROFILE, SWING_PROFILE });
    check("both horizons carry the same RR-aware floor",
      DAY_PROFILE.minExpectancyR === 0.75 && SWING_PROFILE.minExpectancyR === 0.75 &&
      DAY_PROFILE.minHitRate === 0.55 && SWING_PROFILE.minHitRate === 0.55,
      { DAY_PROFILE, SWING_PROFILE });
  }

  // ── the floor measures the managed trade directly ───────────────
  //
  // The flat 70% was the reason Telegram went silent: it refused a
  // demonstrated 58% at 1:2.51 (+1.04R per trade) while passing 70% at 1:1.5
  // (+0.75R). The floor now reads the expectancy straight off the managed
  // backtest — the walk applies the same breakeven/trailing/flip rules the
  // monitor runs live — with a 55% followability leg beside it.
  {
    check("the 58%/+1.04R that Telegram never saw now clears",
      meetsProfileFloor(DAY_PROFILE, { hitRate: 0.58, expectancyR: 1.04 }));
    check("the old 70%-at-1:1.5 bar still clears (it is +0.75R)",
      meetsProfileFloor(DAY_PROFILE, { hitRate: 0.7, expectancyR: 0.75 }));
    check("expectancy below +0.75R is refused whatever the hit rate",
      !meetsProfileFloor(DAY_PROFILE, { hitRate: 0.9, expectancyR: 0.5 }));
    check("a hit rate below 55% is refused whatever it pays",
      !meetsProfileFloor(DAY_PROFILE, { hitRate: 0.4, expectancyR: 2 }));
    check("an unmeasured combo is refused, not excused",
      !meetsProfileFloor(DAY_PROFILE, { hitRate: null, expectancyR: null }));
    check("the reference tier is a flat 55% with no expectancy leg",
      meetsProfileFloor(REFERENCE_PROFILE, { hitRate: 0.55, expectancyR: -0.2 }) &&
      !meetsProfileFloor(REFERENCE_PROFILE, { hitRate: 0.54, expectancyR: 2 }),
      REFERENCE_PROFILE);
    // 實績校準 raises the followability leg; the cap keeps it below certainty.
    const bumped = effectiveDayProfile(0.1);
    check("the calibration bump raises the hit-rate leg",
      profileHitFloor(bumped) === 0.65 &&
      !meetsProfileFloor(bumped, { hitRate: 0.6, expectancyR: 1.5 }),
      profileHitFloor(bumped));
    check("and caps below certainty",
      profileHitFloor({ ...DAY_PROFILE, hitRateBump: 0.5 }) === 0.9,
      profileHitFloor({ ...DAY_PROFILE, hitRateBump: 0.5 }));
  }

  // ── the swing may reach what the day plan excludes ──────────────
  {
    const menu = {
      ...base,
      entryCandidates: [{ price: LAST, label: "現價" }],
      slCandidates: [{ price: LAST - 800, label: "結構外" }],
      tpCandidates: [
        { price: LAST + 1200, label: "近的前高" }, // ~1.7×ATR — day territory
        { price: LAST + 2400, label: "遠的前高" }, // ~3.4×ATR — swing only
      ],
    };
    const day = await buildTradePlan(menu, []);
    check("the day plan stays inside its horizon",
      day.stance === "enter" && Math.abs((day.take_profit ?? 0) - (LAST + 1200)) < 0.01,
      [day.stance, day.take_profit]);

    const swing = selectSwingVariant(menu);
    check("a swing variant exists", swing !== null, swing);
    check("it reaches the target the day plan excluded",
      Math.abs((swing?.take_profit ?? 0) - (LAST + 2400)) < 0.01, swing?.take_profit);
    check("it carries its own hit rate", swing?.hit_rate != null, swing);
    check("and names the expectancy floor", swing?.summary.includes("0.75R") === true, swing?.summary);
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

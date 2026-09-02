import { check, report } from "./_harness";
import {
  DAY_PROFILE,
  SWING_PROFILE,
  REFERENCE_PROFILE,
  TRADE_MIN_EXPECTANCY_R,
  calibratedExpectancy,
  FOLLOWABILITY_ABSOLUTE_MIN,
  followabilityFloor,
  effectiveDayProfile,
  floorText,
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
    // 附加審查架構：the profiles carry VETO lines (expectancy < 0 or hit
    // rate < 40% is removed), not qualifying bars — the operator's explicit
    // instruction after two measurement repairs still left 0-for-11 sweeps.
    // 0.35R/55% survive as the 「強」 display tier.
    check("both horizons carry the same veto lines",
      DAY_PROFILE.minExpectancyR === 0 && SWING_PROFILE.minExpectancyR === 0 &&
      DAY_PROFILE.minHitRate === 0.4 && SWING_PROFILE.minHitRate === 0.4,
      { DAY_PROFILE, SWING_PROFILE });
    // The bar itself: the economic floor, not the aspiration. 0.75R produced
    // one trade a month and refused an A+ measured at +0.69R over 124
    // samples — a rejection inside its own sampling error.
    check("the floor is the economic one", TRADE_MIN_EXPECTANCY_R === 0.35,
      TRADE_MIN_EXPECTANCY_R);
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
    check("the A+ at +0.69R that got refused now clears",
      meetsProfileFloor(DAY_PROFILE, { hitRate: 0.6, expectancyR: 0.69 }));
    check("a measured LOSS is vetoed whatever the hit rate",
      !meetsProfileFloor(DAY_PROFILE, { hitRate: 0.9, expectancyR: -0.01 }));
    check("a positive-but-modest expectancy is admissible — the analysis decides",
      meetsProfileFloor(DAY_PROFILE, { hitRate: 0.5, expectancyR: 0.2 }));
    check("an unfollowable hit rate is vetoed whatever it pays",
      !meetsProfileFloor(DAY_PROFILE, { hitRate: 0.39, expectancyR: 2 }));
    check("40% exactly survives the veto",
      meetsProfileFloor(DAY_PROFILE, { hitRate: 0.4, expectancyR: 0 }));
    check("an unmeasured combo fails the check itself (absence is handled upstream)",
      !meetsProfileFloor(DAY_PROFILE, { hitRate: null, expectancyR: null }));
    check("the reference tier vetoes the same way",
      meetsProfileFloor(REFERENCE_PROFILE, { hitRate: 0.45, expectancyR: 0.1 }) &&
      !meetsProfileFloor(REFERENCE_PROFILE, { hitRate: 0.45, expectancyR: -0.2 }),
      REFERENCE_PROFILE);
    // 實績校準 haircuts the backtest's hit rate before the EXPECTANCY leg is
    // judged. The hit-rate veto line itself never moves — the old bump raised
    // it to 50%, which at measured 37–45% hit rates was a shutdown on the
    // supplementary metric.
    const calibrated = effectiveDayProfile(0.15);
    check("calibration never moves the hit-rate veto line",
      profileHitFloor(calibrated) === profileHitFloor(DAY_PROFILE), profileHitFloor(calibrated));
    // 45% × 2.5R: at a realistic 30% it still pays (+0.05R) — survives.
    check("a geometry with real margin survives the haircut",
      meetsProfileFloor(calibrated, { hitRate: 0.45, expectancyR: 0.58, avgWinR: 2.5, avgLossR: -1 }));
    // 45% × 1.5R: at 30% it loses (−0.25R) — vetoed, though its raw expectancy is positive.
    check("a geometry whose edge only existed at the promised rate is vetoed",
      !meetsProfileFloor(calibrated, { hitRate: 0.45, expectancyR: 0.13, avgWinR: 1.5, avgLossR: -1 }));
    check("the same geometry passes with no calibration",
      meetsProfileFloor(DAY_PROFILE, { hitRate: 0.45, expectancyR: 0.13, avgWinR: 1.5, avgLossR: -1 }));
    // A row without the payoff shape cannot be haircut honestly — fall back
    // to its raw expectancy rather than inventing one.
    check("a backtest without avgWin/avgLoss falls back to its raw expectancy",
      meetsProfileFloor(calibrated, { hitRate: 0.45, expectancyR: 0.13 }));
    check("calibratedExpectancy does the arithmetic it says",
      calibratedExpectancy({ hitRate: 0.45, avgWinR: 2.5, avgLossR: -1 }, 0.15) === 0.05);
    check("and the floor text names the calibration when it is active",
      floorText(calibrated).includes("扣 15 點") && !floorText(DAY_PROFILE).includes("扣"));
    check("the haircut is capped", (effectiveDayProfile(0.5).hitRateShortfall ?? 0) === 0.2);

    // 跟單性否決線隨賠率下修 — WTI: +1.08R at 38%, thrown out for 2 points
    // under a flat 40%. A 2.5R geometry breaks even at 29%.
    // WTI's +1.08R at 38% implies a payoff near 4.5R (0.38·W − 0.62 = 1.08);
    // that geometry breaks even at 18% and the bent line sits at 28%.
    check("a high-payoff geometry is judged at breakeven + margin, not the flat line",
      followabilityFloor(DAY_PROFILE, { avgWinR: 4.5, avgLossR: -1 }) < 0.3 &&
        meetsProfileFloor(DAY_PROFILE, { hitRate: 0.38, expectancyR: 1.08, avgWinR: 4.5, avgLossR: -1 }),
      followabilityFloor(DAY_PROFILE, { avgWinR: 4.5, avgLossR: -1 }));
    check("a 2.5R geometry bends the line to just under 40%",
      followabilityFloor(DAY_PROFILE, { avgWinR: 2.5, avgLossR: -1 }) === 0.3857);
    check("a 1.5R geometry is still judged at the flat line",
      followabilityFloor(DAY_PROFILE, { avgWinR: 1.5, avgLossR: -1 }) === profileHitFloor(DAY_PROFILE) &&
        !meetsProfileFloor(DAY_PROFILE, { hitRate: 0.38, expectancyR: 0.2, avgWinR: 1.5, avgLossR: -1 }));
    check("the line only ever bends down, never up",
      followabilityFloor(DAY_PROFILE, { avgWinR: 0.8, avgLossR: -1 }) === profileHitFloor(DAY_PROFILE));
    check("and never below the absolute minimum — a lottery ticket is not a trade",
      followabilityFloor(DAY_PROFILE, { avgWinR: 20, avgLossR: -1 }) === FOLLOWABILITY_ABSOLUTE_MIN);
    check("without a payoff shape the flat line stands",
      followabilityFloor(DAY_PROFILE, {}) === profileHitFloor(DAY_PROFILE));
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
    check("and names the expectancy floor",
      swing?.summary.includes(`${TRADE_MIN_EXPECTANCY_R}R`) === true, swing?.summary);
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

  // ── 持有上限也要分層 ─────────────────────────────────────────
  //
  // A flat 20-bar clock for both tiers made 波段 a label rather than a trade:
  // the swing target may sit 5×ATR away and was given the same month to get
  // there as a 2×ATR day target. A trade closed on the clock while in profit
  // is a small win by construction, and that was a measurable share of the
  // 「小獲利」 the operator reported.
  check("the swing tier holds longer than the day tier",
    SWING_PROFILE.horizonBars > DAY_PROFILE.horizonBars,
    [DAY_PROFILE.horizonBars, SWING_PROFILE.horizonBars]);
  check("the day tier's clock is unchanged — a 當沖 held two months is not a 當沖",
    DAY_PROFILE.horizonBars === 20, DAY_PROFILE.horizonBars);
  check("the reference tier measures on the day clock, like the plan it mirrors",
    REFERENCE_PROFILE.horizonBars === DAY_PROFILE.horizonBars, REFERENCE_PROFILE.horizonBars);
  // The reach and the clock must move together: a target allowed further away
  // with the same time to get there is a target the sample cannot resolve.
  check("further reach comes with more time, in the same proportion or better",
    SWING_PROFILE.horizonBars / DAY_PROFILE.horizonBars >= 1.5,
    SWING_PROFILE.horizonBars / DAY_PROFILE.horizonBars);
  // The calibration bump must not quietly reset the clock.
  check("the calibration bump preserves the day clock",
    effectiveDayProfile(0.05).horizonBars === DAY_PROFILE.horizonBars);

  report("dual horizons");
}

void main();

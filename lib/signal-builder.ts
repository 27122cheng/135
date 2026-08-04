import type { BiasItem, CommodityMeta, SupportedSymbol, TradeSignal } from "@/types/signal";
import { COMMODITIES } from "@/types/signal";
import { FUNDAMENTALS_CONFIG, type FundamentalsConfig } from "@/config/fundamentals";
import { fetchOHLCV } from "./data-sources/ohlcv";
import { atr as computeAtr } from "./analysis/indicators";
import { analyzeTechnical } from "./analysis/technical";
import { analyzeFundamental } from "./analysis/fundamental";
import { analyzePositioning } from "./analysis/positioning";
import { analyzeNews } from "./analysis/news";
import { analyzeFundFlow } from "./analysis/fundflow";
import { analyzeOpenInterest } from "./analysis/open-interest";
import { backtestPlanGeometry } from "./analysis/backtest";
import { generateNarrative } from "./analysis/ai-narrative";
import { buildTradePlan, collectCandidates } from "./analysis/trade-plan";
import { scoreSignal } from "./scoring";
import { buildStopLoss, buildTakeProfits } from "./entry-exit";
import { getSignalStore } from "./db";
import { fetchEconomicCalendar } from "./data-sources/finnhub";
import {
  applyGradePenalties,
  assertNeverLoosened,
  computeInterventions,
  DEFAULT_EFFECTS,
  LOOKBACK,
  type InterventionEffects,
} from "./journal/interventions";
import type { AppliedIntervention } from "@/types/journal";

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Loads this symbol's review history and turns it into the tightenings that
 * apply to the signal being built. Scoped per symbol on purpose: a run of bad
 * EURUSD entries says nothing about gold.
 *
 * A missing or failing database is not an error here — it just means no
 * history, so no interventions. The signal is still produced.
 */
async function loadInterventions(
  symbol: string,
  gaps: string[],
): Promise<InterventionEffects> {
  const store = getSignalStore();
  if (!store) return DEFAULT_EFFECTS;
  try {
    const history = await store.listJournal({ symbol, limit: LOOKBACK });
    const effects = computeInterventions(history);
    // Fails loudly if a future edit ever makes a knob looser than baseline.
    assertNeverLoosened(effects);
    return effects;
  } catch (err) {
    gaps.push(
      `讀取交易日誌失敗，本次未套用任何干涉規則（${err instanceof Error ? err.message : String(err)}）`,
    );
    return DEFAULT_EFFECTS;
  }
}

/** Net weighted direction of one dimension's items; null when they cancel out. */
function netDirection(items: BiasItem[]): "long" | "short" | null {
  const net = items.reduce((sum, item) => {
    if (item.direction === "long") return sum + item.weight;
    if (item.direction === "short") return sum - item.weight;
    return sum;
  }, 0);
  return net > 0 ? "long" : net < 0 ? "short" : null;
}

/**
 * Whether a high-impact release lands in the next 24h, for the S4 penalty.
 * Returns `available: false` when no calendar source is configured — the
 * caller must then decline to act rather than assume either answer.
 */
async function highImpactWithin24h(
  gaps: string[],
): Promise<{ available: boolean; present: boolean }> {
  const events = await fetchEconomicCalendar(gaps);
  if (!events) return { available: false, present: false };
  const cutoff = Date.now() + 24 * 60 * 60 * 1000;
  const present = events.some((e) => {
    const at = new Date(e.time).getTime();
    if (!Number.isFinite(at) || at < Date.now() || at > cutoff) return false;
    return (e.impact ?? "").toLowerCase().includes("high");
  });
  return { available: true, present };
}

function pickDirection(biasItems: BiasItem[]): { direction: "long" | "short"; tie: boolean } {
  const net = biasItems.reduce((sum, item) => {
    if (item.direction === "long") return sum + item.weight;
    if (item.direction === "short") return sum - item.weight;
    return sum;
  }, 0);
  if (net === 0) return { direction: "long", tie: true };
  return { direction: net > 0 ? "long" : "short", tie: false };
}

/**
 * Fallback when no timeframe returned candles: a structurally valid, honest
 * no-trade signal. Every price field is 0 and labelled as unavailable — this
 * is deliberately not a guess at the market price.
 */
function buildNoPriceSignal(
  meta: CommodityMeta,
  gaps: string[],
  biasItems: BiasItem[],
): TradeSignal {
  return {
    symbol: meta.symbol,
    direction: "long",
    generated_at: new Date().toISOString(),
    bias_score: 0,
    entry_structure_score: 0,
    total_score: 0,
    grade: "no-trade",
    entry_zone: { low: 0, high: 0, reason: "無價格資料，無法計算進場區間" },
    stop_loss: {
      price: 0,
      structure: "無價格資料",
      reason: "無法取得任何時框的 K 棒，無結構可錨定停損",
      invalidation: "no-trade：訊號不成立",
    },
    take_profits: [],
    bias_items: biasItems,
    entry_structures: [],
    path_obstacles: [],
    trade_plan: {
      stance: "wait",
      entry: null,
      stop_loss: null,
      take_profit: null,
      entry_reason: "—",
      stop_loss_reason: "—",
      take_profit_reason: "—",
      risk_reward: null,
      confidence: "low",
      summary: "無法取得價格資料，只能觀望。",
      wait_for: "等待價格資料來源恢復（見資料缺口）。",
      decided_by: "fallback",
    },
    plan_backtest: null,
    interventions: [],
    narrative:
      `${meta.symbol} 無法產生有效訊號：所有 OHLCV 來源皆取得失敗（行情代理、Finnhub、Stooq 都沒有回應可用資料）。` +
      `請檢查 /api/diagnostics 確認各資料來源在部署環境的連線狀態。` +
      (biasItems.length > 0
        ? `其餘面向仍取得 ${biasItems.length} 項因子，已列於下方供參考，但沒有價格就沒有可執行的進出場。`
        : ""),
    data_gaps: [...new Set(gaps)],
  };
}

/** End-to-end Stage 2 pipeline: works for any of the 9 COMMODITIES via config/fundamentals.ts. */
export async function buildTradeSignal(symbol: string): Promise<TradeSignal> {
  const meta = COMMODITIES.find((c) => c.symbol === symbol);
  if (!meta) {
    throw new Error(`Unknown symbol ${symbol}`);
  }
  const config = FUNDAMENTALS_CONFIG[meta.symbol as SupportedSymbol];
  return buildSignalForSymbol(meta, config);
}

/** Runs the pipeline for an arbitrary target — used by user-added symbols. */
export async function buildSignalFor(
  meta: CommodityMeta,
  config: FundamentalsConfig,
): Promise<TradeSignal> {
  return buildSignalForSymbol(meta, config);
}

async function buildSignalForSymbol(
  meta: CommodityMeta,
  config: FundamentalsConfig,
): Promise<TradeSignal> {
  const gaps: string[] = [];

  // OHLCV and the five non-technical dimensions don't depend on each other,
  // so they run concurrently — serverless request budgets are tight.
  const ohlcvPromise = Promise.all([
    fetchOHLCV(meta, "D1", gaps),
    fetchOHLCV(meta, "H4", gaps),
    fetchOHLCV(meta, "W1", gaps),
  ]);
  // Journal history is independent of every market call, so it loads alongside them.
  const interventionsPromise = loadInterventions(meta.symbol, gaps);
  const nonTechnicalPromise = (async () => {
    // Positioning first — fundFlow reuses its COT reports instead of re-fetching.
    const positioning = await analyzePositioning(meta, config, gaps);
    const [fundamentalItems, news, fundFlowItems] = await Promise.all([
      analyzeFundamental(meta, config, gaps),
      analyzeNews(config.gdeltQuery, config.newsKeywords, gaps),
      analyzeFundFlow(meta, config, positioning.reports, gaps),
    ]);
    return { positioning, fundamentalItems, news, fundFlowItems };
  })();

  const [[d1, h4, w1], nonTechnical, effects] = await Promise.all([
    ohlcvPromise,
    nonTechnicalPromise,
    interventionsPromise,
  ]);
  const { positioning, fundamentalItems, news, fundFlowItems } = nonTechnical;
  const interventions: AppliedIntervention[] = [...effects.applied];

  const candlesByTf = {
    D1: d1?.candles,
    H4: h4?.candles,
    W1: w1?.candles,
  };

  const currentPrice = d1?.candles.at(-1)?.close ?? h4?.candles.at(-1)?.close ?? w1?.candles.at(-1)?.close;
  if (currentPrice == null) {
    // Without a price there is no entry, no structure and no valid signal — but
    // the other five dimensions may still have produced real findings, so return
    // a no-trade signal carrying them plus the reason, instead of failing the
    // whole request and leaving the UI with nothing to show.
    gaps.push("所有時框的 OHLCV 皆取得失敗，無法計算即時價位，訊號強制為 no-trade");
    return buildNoPriceSignal(meta, gaps, [
      ...fundamentalItems,
      ...positioning.biasItems,
      ...news.biasItems,
      ...fundFlowItems,
    ]);
  }

  const atrD1 = d1 ? computeAtr(d1.candles, 14) : null;
  if (atrD1 == null) gaps.push("D1 K棒不足以計算 ATR(14)");
  const technical = analyzeTechnical(candlesByTf, currentPrice, atrD1, gaps);

  // Open interest needs both the COT reports and price over the same weeks, so
  // it runs here rather than inside fundFlow — pure computation, no fetching.
  const openInterestItems = analyzeOpenInterest(meta, positioning.reports, d1?.candles ?? null, gaps);

  const biasItems: BiasItem[] = [
    ...technical.biasItems,
    ...fundamentalItems,
    ...positioning.biasItems,
    ...news.biasItems,
    ...fundFlowItems,
    ...openInterestItems,
  ];

  const { direction, tie } = pickDirection(biasItems);
  if (tie) gaps.push("六面向淨方向票數為 0，方向判定採預設 long（僅為平手時的決定規則，非市場訊號）");

  // S2 intervention narrows the zone; the factor is ≤ 1 by construction.
  const baseZoneBuffer = atrD1 && atrD1 > 0 ? atrD1 * 0.15 : currentPrice * 0.0005;
  const zoneBuffer = baseZoneBuffer * effects.entryZoneWidthFactor;
  const narrowedNote =
    effects.entryZoneWidthFactor < 1
      ? `（S2 干涉：區間已收窄至 ${Math.round(effects.entryZoneWidthFactor * 100)}%）`
      : "";
  const entryZone = {
    low: round(currentPrice - zoneBuffer),
    high: round(currentPrice + zoneBuffer),
    reason:
      (atrD1
        ? `即時價位 ${round(currentPrice)} ± 0.15×ATR(14)×${effects.entryZoneWidthFactor}=${round(zoneBuffer)}`
        : `ATR 不可得，改用即時價位 ${round(currentPrice)} ± 0.05% 作為極小容差`) + narrowedNote,
  };

  const score = scoreSignal(
    direction,
    entryZone,
    biasItems,
    technical.entryStructures,
    effects.biasScoreThresholdBump,
  );

  const stopLoss = buildStopLoss(
    direction,
    entryZone,
    technical.entryStructures,
    atrD1,
    effects.stopBufferAtrMultiple,
  );
  const takeProfits = buildTakeProfits(direction, entryZone, technical.pathObstacles);

  let grade = score.grade;
  const finalStopLoss = stopLoss ?? {
    price: round(currentPrice),
    structure: "無足夠結構保護",
    reason: "找不到符合條件（距離進場 ≤1.5%）的支撐/壓力結構，不提供結構錨定停損",
    invalidation: "no-trade：訊號不成立，此價位僅為當前市價參考，非實際停損建議",
  };
  if (!stopLoss) {
    grade = "no-trade";
    gaps.push("無法錨定有效停損結構，訊號強制降級為 no-trade");
  }
  if (takeProfits.length === 0) {
    grade = "no-trade";
    gaps.push("path_obstacles 中找不到方向正確的停利價位，訊號強制降級為 no-trade");
  }

  // ── Stage 3 干涉 ────────────────────────────────────────────────
  // Everything below can only hold the grade or push it down. `grade` at this
  // point is the baseline the penalties are clamped against.
  const baselineGrade = grade;

  if (effects.requirePullbackConfirmation) {
    // S2 also demands a pullback-confirmation factor: a protecting structure
    // the price could retrace into before entry. Without one there is nothing
    // to confirm, so the signal doesn't qualify.
    const mid = (entryZone.low + entryZone.high) / 2;
    const hasPullback = technical.entryStructures.some((s) =>
      direction === "long"
        ? s.role === "support" && s.price < mid && Math.abs(s.distance_pct) <= 1.5
        : s.role === "resistance" && s.price > mid && Math.abs(s.distance_pct) <= 1.5,
    );
    if (!hasPullback) {
      grade = "no-trade";
      gaps.push("S2 干涉：強制要求回測確認因子，但找不到可回測的保護結構，訊號降為 no-trade");
    }
  }

  const eventCheck = effects.downgradeOnHighImpactEvent
    ? await highImpactWithin24h(gaps)
    : { available: false, present: false };

  const penalties = applyGradePenalties(grade, effects, {
    highImpactEventWithin24h: eventCheck.present,
    eventDataAvailable: eventCheck.available,
    generatedAt: new Date(),
    // S7: the 基本面 dimension's net direction opposing the signal.
    fundamentalOpposesSignal: (() => {
      const net = netDirection(fundamentalItems);
      return net !== null && net !== direction;
    })(),
    // S8: COT at a 52-week extreme whose mean-reversion side opposes the signal.
    positioningExtremeOpposesSignal:
      positioning.extremeDirection !== null && positioning.extremeDirection !== direction,
  });
  grade = penalties.grade;
  gaps.push(...penalties.notes);

  if (grade !== baselineGrade) {
    // The net grade change gets its own line so the card can show the outcome
    // without the reader diffing two grades themselves. No single tag owns it —
    // several penalties can stack — so `tag` is null here.
    interventions.push({
      tag: null,
      effect: `評等由 ${baselineGrade} 降為 ${grade}`,
      evidence: penalties.notes.join("；") || "干涉規則觸發",
      triggered_by: [],
    });
  }

  const narrative = await generateNarrative(
    {
      symbol: meta.symbol,
      direction,
      bias_score: score.biasScore,
      entry_structure_score: score.entryStructureScore,
      total_score: score.totalScore,
      grade,
      bias_items: biasItems,
      entry_structures: technical.entryStructures,
      path_obstacles: technical.pathObstacles,
      news_summary: news.summary,
    },
    gaps,
  );

  // The single actionable recommendation. Candidates come from the real
  // structures computed above; the AI only picks among them.
  const { entryCandidates, slCandidates, tpCandidates } = collectCandidates(
    {
      direction,
      entry_zone: entryZone,
      stop_loss: finalStopLoss,
      take_profits: takeProfits,
      entry_structures: technical.entryStructures,
    },
    atrD1,
  );
  // Even on a no-trade grade the AI is still asked to weigh in — it can't turn
  // it into an entry (gradeForcesWait), but it can explain what to wait for.
  const tradePlan = await buildTradePlan(
    {
      symbol: meta.symbol,
      direction,
      grade,
      bias_score: score.biasScore,
      entry_structure_score: score.entryStructureScore,
      total_score: score.totalScore,
      bias_items: biasItems,
      entryCandidates,
      slCandidates,
      tpCandidates,
      narrative,
      knownGaps: [...new Set(gaps)],
      gradeForcesWait: grade === "no-trade",
    },
    gaps,
  );

  // Local historical check on the plan's geometry — pure computation over the
  // D1 candles we already have. No AI, no extra request.
  const planBacktest =
    tradePlan.stance === "enter" &&
    tradePlan.entry !== null &&
    tradePlan.stop_loss !== null &&
    tradePlan.take_profit !== null &&
    tradePlan.risk_reward !== null &&
    d1
      ? backtestPlanGeometry(
          direction,
          tradePlan.entry,
          tradePlan.stop_loss,
          tradePlan.take_profit,
          d1.candles,
          tradePlan.risk_reward,
        )
      : null;
  if (tradePlan.stance === "enter" && !planBacktest) {
    gaps.push("D1 K棒不足，無法對交易計畫做歷史幾何檢驗");
  }

  const dedupedGaps = [...new Set(gaps)];

  const signal: TradeSignal = {
    symbol: meta.symbol,
    direction,
    generated_at: new Date().toISOString(),
    bias_score: score.biasScore,
    entry_structure_score: score.entryStructureScore,
    total_score: score.totalScore,
    grade,
    entry_zone: entryZone,
    stop_loss: finalStopLoss,
    take_profits: takeProfits,
    bias_items: biasItems,
    entry_structures: technical.entryStructures,
    path_obstacles: technical.pathObstacles,
    narrative,
    trade_plan: tradePlan,
    plan_backtest: planBacktest,
    interventions,
    data_gaps: dedupedGaps,
  };

  return signal;
}

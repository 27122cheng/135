import type { BiasItem, CommodityMeta, SupportedSymbol, TradeSignal } from "@/types/signal";
import { COMMODITIES } from "@/types/signal";
import { FUNDAMENTALS_CONFIG, type FundamentalsConfig } from "@/config/fundamentals";
import { fetchOHLCV, type Candle } from "./data-sources/ohlcv";
import { fetchLatestPrice } from "./data-sources/yfinance";
import { atr as computeAtr } from "./analysis/indicators";
import { analyzeTechnical } from "./analysis/technical";
import { analyzeTiming } from "./analysis/timing";
import { detectAllPatterns, patternContributions } from "./analysis/patterns";
import { dedupeBiasItems } from "./analysis/evidence";
import { describeProximity, isNearEntry } from "./analysis/proximity";
import { marketStatus } from "./market-hours";
import { analyzeFundamental } from "./analysis/fundamental";
import { analyzePositioning } from "./analysis/positioning";
import { analyzeNews } from "./analysis/news";
import { analyzeFundFlow } from "./analysis/fundflow";
import { analyzeOpenInterest } from "./analysis/open-interest";
import { backtestPlanGeometry } from "./analysis/backtest";
import { generateNarrative, ruleNarrative } from "./analysis/ai-narrative";
import {
  buildTradePlan,
  collectCandidates,
  selectReferenceGeometry,
  selectSwingVariant,
} from "./analysis/trade-plan";
import { buildAddOns } from "./analysis/add-on";
import {
  describeGate,
  evaluateAdoption,
  findAdoption,
  loadAdoptionsFor,
  type LabAdoption,
} from "./analysis/lab-adoption";
import { CONFIDENT_ENTRY_MIN, clearsEntryBar, planConfidence } from "./analysis/confidence";
import { applyTrendAlignmentGate, gradeAllowsEntry, scoreSignal, weightedNet } from "./scoring";
import { collapseCascades } from "./data-gaps";
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

/**
 * The most recently printed bar among whatever timeframes answered.
 * Exported for tests: this replaced an `??` chain whose first-that-exists
 * semantics let a frozen H4 series hide a fresh Stooq D1 bar, and it is the
 * kind of one-liner a tidy-up would happily fold back into `??`.
 */
export function freshestBar<T extends { time: string }>(
  ...bars: (T | undefined)[]
): T | undefined {
  return bars.reduce<T | undefined>((best, bar) => {
    if (!bar) return best;
    if (!best) return bar;
    return new Date(bar.time).getTime() > new Date(best.time).getTime() ? bar : best;
  }, undefined);
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
  // The same weighting `computeBiasScore` uses, deliberately: picking a side
  // by a flat vote and then scoring conviction by a capped one would let the
  // system commit to a direction its own score cannot justify.
  const net = weightedNet(biasItems);
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
      add_ons: [],
      wait_for: "等待價格資料來源恢復（見資料缺口）。",
      decided_by: "fallback",
    },
    plan_backtest: null,
    interventions: [],
    news_digest: null,
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
  // 實驗室已採用條件 — same story, and the settings cache makes nine symbols
  // in one scan cost one round trip.
  const adoptionsPromise = loadAdoptionsFor(meta.symbol, gaps);
  const nonTechnicalPromise = (async () => {
    // Positioning first — fundFlow reuses its COT reports instead of re-fetching.
    const positioning = await analyzePositioning(meta, config, gaps);
    const [fundamentalItems, news, fundFlowItems] = await Promise.all([
      analyzeFundamental(meta, config, gaps),
      analyzeNews(config.gdeltQuery, config.newsKeywords, gaps, meta.symbol),
      analyzeFundFlow(meta, config, positioning.reports, gaps),
    ]);
    return { positioning, fundamentalItems, news, fundFlowItems };
  })();

  const [[d1, h4, w1], nonTechnical, effects, adoptions] = await Promise.all([
    ohlcvPromise,
    nonTechnicalPromise,
    interventionsPromise,
    adoptionsPromise,
  ]);
  const { positioning, fundamentalItems, news, fundFlowItems } = nonTechnical;
  const interventions: AppliedIntervention[] = [...effects.applied];

  const candlesByTf = {
    D1: d1?.candles,
    H4: h4?.candles,
    W1: w1?.candles,
  };

  // The live quote, not the last daily close.
  //
  // This was `d1.candles.at(-1).close`, and it is why "重新分析" changed
  // nothing: on a daily feed that is yesterday's settlement, so every rescan
  // rebuilt the entry zone around the same number no matter how far the market
  // had moved. NAS100 came back with a long entry zone of 29,829–30,043 while
  // the instrument was trading 29,369 — the levels were not stale, they were
  // describing a different day, and no amount of refreshing could fix that
  // because the input never changed.
  //
  // The 5-minute monitor has always used this quote (2-minute TTL); the analysis
  // that produces the levels the monitor watches was using something else
  // entirely. Same feed, one call, and now a rescan two minutes later genuinely
  // sees a new price.
  const quote = await fetchLatestPrice(meta.yfinanceSymbol, gaps, meta.stooqSymbol, meta.symbol);

  // The candles are a second, independent witness to both questions the quote
  // was answering alone: what the price is, and when the market last traded.
  //
  // That independence turned out to matter. Yahoo's direct chart endpoint
  // served this deployment quotes whose last trade was 104 hours old on a
  // Tuesday morning — while the candle proxy, a different route, had bars
  // minutes old. Under `quote?.price ?? lastClose`, existing beat fresh: the
  // four-day-old quote won because it merely *existed*, the entry zone was
  // built 1% away from the market, and the staleness gate — correctly reading
  // a 104-hour age — kept nine open instruments labelled 休市中 all day.
  //
  // So the rule is freshness, not precedence: whichever witness printed most
  // recently supplies the price, and the market-hours check hears both.
  // Freshest bar across timeframes, not first-that-exists. The `??` chain
  // this replaces had the same existence-beats-freshness disease the quote
  // was cured of: H4 has no Stooq fallback, so a Yahoo freeze leaves H4
  // holding week-old last-resort bars while D1 — which *does* fall through to
  // Stooq — has yesterday's. H4 merely existing then aged the bar witness by
  // days, and the symbols whose Stooq quote also failed stayed 休市中 while
  // their D1 candles quietly disproved it. Intraday nothing changes: a live
  // H4 bucket is always newer than today's D1 bucket.
  const lastBar = freshestBar(h4?.candles.at(-1), d1?.candles.at(-1), w1?.candles.at(-1));
  const lastClose = lastBar?.close;
  const barAgeMinutes = lastBar
    ? Math.max(0, (Date.now() - new Date(lastBar.time).getTime()) / 60000)
    : null;
  const quoteBeatsBar =
    quote !== null &&
    (barAgeMinutes === null || quote.ageMinutes <= barAgeMinutes + 60);

  if (quote && quoteBeatsBar && quote.ageMinutes > 60 && quote.ageMinutes <= 180) {
    gaps.push(
      `即時報價已延遲 ${Math.round(quote.ageMinutes)} 分鐘（${quote.at.slice(11, 16)} UTC），進場區間以此價位計算`,
    );
  }
  if (quote && !quoteBeatsBar) {
    gaps.push(
      `即時報價來源已 ${Math.round((quote.ageMinutes / 60) * 10) / 10} 小時未更新，` +
        `K 棒較新，進場區間改用最新 K 棒收盤價計算`,
    );
  }
  if (!quote && lastClose != null) {
    gaps.push("取不到即時報價，進場區間改用最後一根 K 棒收盤價計算，可能與市價有落差");
  }
  // The clock and both feeds, together. Nothing here stops the analysis;
  // a closed verdict stops the notification.
  const market = marketStatus(
    new Date(),
    quote ? quote.ageMinutes : null,
    barAgeMinutes,
    meta.category,
  );
  if (market.closed && market.reason) gaps.push(market.reason);

  const currentPrice = quote && quoteBeatsBar ? quote.price : (lastClose ?? quote?.price);
  const priceBasis =
    quote && quoteBeatsBar
      ? `即時報價 ${round(quote.price)}（${Math.round(quote.ageMinutes)} 分鐘前）`
      : lastClose != null
        ? `最新 K 棒收盤價 ${round(lastClose)}` +
          (barAgeMinutes !== null ? `（K 棒起點 ${Math.round(barAgeMinutes)} 分鐘前）` : "") +
          (quote ? "，即時報價來源停更未採用" : "，取不到即時報價")
        : `即時報價 ${quote ? round(quote.price) : "—"}（K 棒不可得）`;
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

  // 圖形交易. Detected separately from the indicator work because a pattern is
  // a shape over pivots rather than a reading at the last bar, but folded into
  // the same three lists so everything downstream — scoring, the stop anchor,
  // the take-profit ladder, the AI's candidate menu — sees pattern levels as
  // exactly what they are: structures, on the same footing as a prior high.
  //
  // Only confirmed patterns contribute anything; see patternContributions.
  const chartPatterns = detectAllPatterns(candlesByTf, gaps);
  const patternParts = patternContributions(chartPatterns, currentPrice);
  technical.entryStructures.push(...patternParts.entryStructures);
  technical.pathObstacles.push(...patternParts.pathObstacles);

  // Open interest needs both the COT reports and price over the same weeks, so
  // it runs here rather than inside fundFlow — pure computation, no fetching.
  const openInterestItems = analyzeOpenInterest(meta, positioning.reports, d1?.candles ?? null, gaps);

  // 時間與事件因子 — session windows, NFP day, weekend gap risk, month-end.
  // Weight-0 readings from the clock alone; they inform, never vote.
  const timing = analyzeTiming(new Date());

  const rawBiasItems: BiasItem[] = [
    ...technical.biasItems,
    ...patternParts.biasItems,
    ...fundamentalItems,
    ...positioning.biasItems,
    ...news.biasItems,
    ...fundFlowItems,
    ...openInterestItems,
    ...timing.items,
  ];

  // 一個事實，一票。基本面與資金流都在讀同一個 VIX/DXY，兩邊各記一票，
  // bias_score 就憑空多出最多 2 分——A 的門檻才 6 分。
  // The merge notes are deliberately NOT pushed into data_gaps. They landed
  // there first, and the card then counted "usd-dxy-trend 已合併為一票" as a
  // *data gap* and the confidence score billed it −3 — a penalty for the
  // dedupe working. A merge is bookkeeping, not missing evidence, and the
  // merged item's own factor text already says 已合併為一票 where the reader
  // looks for it.
  const deduped = dedupeBiasItems(rawBiasItems);
  const biasItems = deduped.items;

  const { direction, tie } = pickDirection(biasItems);
  if (tie) {
    // Almost always a symptom rather than a finding: with several sources down
    // there are no weighted items left to vote. Say which case it is.
    gaps.push(
      biasItems.length === 0
        ? "沒有任何面向產生因子（見上方失敗項），無方向可判，訊號必為 no-trade"
        : "六面向淨方向票數為 0（多空因子權重相抵），方向判定採預設 long —— 僅為平手時的決定規則，非市場訊號",
    );
  }

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
        ? `${priceBasis} ± 0.15×ATR(14)×${effects.entryZoneWidthFactor}=${round(zoneBuffer)}`
        : `ATR 不可得，改用 ${priceBasis} ± 0.05% 作為極小容差`) + narrowedNote,
  };

  const score = scoreSignal(
    direction,
    entryZone,
    biasItems,
    technical.entryStructures,
    effects.biasScoreThresholdBump,
    // "Near the entry" is 2×ATR, not 1.5% of price — see lib/analysis/proximity.ts.
    atrD1,
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
  // Every reason the computed grade was overruled, in order. The card showed
  // "評等 no-trade（方向分 10、結構分 2、總分 12）未達可進場門檻 B" — which
  // reads as a contradiction, because by the scoring table 12 points *is* an A.
  // The grade had been force-downgraded, and the only trace of it was one line
  // buried among the data gaps.
  const downgrades: string[] = [];
  const finalStopLoss = stopLoss ?? {
    price: round(currentPrice),
    structure: "無足夠結構保護",
    reason: `找不到符合條件（${describeProximity(currentPrice, atrD1)}）的支撐/壓力結構，不提供結構錨定停損`,
    invalidation: "no-trade：訊號不成立，此價位僅為當前市價參考，非實際停損建議",
  };
  if (!stopLoss) {
    grade = "no-trade";
    const why = `找不到 ${describeProximity(currentPrice, atrD1)}、方向正確的支撐／壓力結構，沒有東西可以錨定停損`;
    gaps.push(`無法錨定有效停損結構，訊號強制降級為 no-trade（${why}）`);
    downgrades.push(`無法錨定停損：${why}`);
  }
  if (takeProfits.length === 0) {
    grade = "no-trade";
    const why = "path_obstacles 裡沒有任何在進場價前方、方向正確的障礙";
    gaps.push(`找不到方向正確的停利價位，訊號強制降級為 no-trade（${why}）`);
    downgrades.push(`無法錨定停利：${why}`);
  }

  // 逆勢不對稱 — part of scoring policy, not a Stage 3 intervention, so it
  // lands before the baseline the interventions are clamped against.
  const trendGate = applyTrendAlignmentGate(grade, direction, biasItems, score.biasScore);
  if (trendGate.note) gaps.push(trendGate.note);
  if (trendGate.grade !== grade) {
    downgrades.push(trendGate.note!);
    grade = trendGate.grade;
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
        ? s.role === "support" && s.price < mid && isNearEntry(s, mid, atrD1)
        : s.role === "resistance" && s.price > mid && isNearEntry(s, mid, atrD1),
    );
    if (!hasPullback) {
      grade = "no-trade";
      gaps.push("S2 干涉：強制要求回測確認因子，但找不到可回測的保護結構，訊號降為 no-trade");
      downgrades.push("S2 干涉：要求回測確認，但沒有可回測的保護結構");
    }
  }

  // The calendar check used to be blind without a Finnhub key. The clock-
  // derived NFP flag makes the S4 downgrade able to fire on the one release
  // whose schedule is pure arithmetic, key or no key.
  const eventCheck = effects.downgradeOnHighImpactEvent
    ? await highImpactWithin24h(gaps).then((c) => ({
        available: c.available || timing.highImpactWithin24h,
        present: c.present || timing.highImpactWithin24h,
      }))
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
  if (penalties.grade !== baselineGrade) downgrades.push(...penalties.notes);

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

  // 敘述只為可能成交的訊號生成。
  //
  // On a typical sweep most symbols grade below the entry floor, and for those
  // the narrative is decoration — nobody reads a paragraph explaining why a
  // C-grade isn't a trade, and it costs a full AI call each. Three calls per
  // symbol × nine symbols is what exhausted a free daily token budget; this
  // removes roughly a third of them on the runs that were never going to
  // produce anything.
  //
  // The deterministic local summary still gets written, so the card is never
  // blank — it just isn't paid for with tokens.
  const narrativeInput = {
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
    news_key_points: news.digest?.key_points.map((k) => ({
      point: k.point,
      impact: k.impact,
    })),
  };
  const narrative = gradeAllowsEntry(grade)
    ? await generateNarrative(narrativeInput, gaps, meta.symbol)
    : ruleNarrative(narrativeInput, `評等 ${grade} 不可交易，未動用 AI 額度`);

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
      // So the geometry is chosen on what has actually happened to this
      // instrument, not on which combination has the prettiest ratio.
      candles: d1?.candles,
      // Lets the geometry search reject a stop inside the noise and a target
      // the 20-bar horizon cannot reach — neither of which a ratio can express.
      atr: atrD1,
      // 實績校準：realized outcomes auditing the backtest's promises. When
      // the journal says the 70% floor has been delivering far less, the
      // floor rises until the scoreboard recovers.
      dayHitRateFloorBump: effects.dayHitRateFloorBump,
      // One model call per symbol per cache window, not one per sweep: the
      // prompt embeds live prices, so hashing it made every hourly scan a
      // fresh question and the 4-hour cache never once hit.
      aiCacheKey: meta.symbol,
    },
    gaps,
  );

  // 參考價位 gets the same selection the traded plan gets — ATR screens,
  // backtest, hit-rate floor, expectancy — so the levels shown when the rules
  // stand aside are an analysis rather than a list of nearby prices.
  const referenceGeometry =
    tradePlan.stance === "enter"
      ? null
      : selectReferenceGeometry({
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
          knownGaps: [],
          gradeForcesWait: false,
          candles: d1?.candles,
          atr: atrD1,
        });

  if (tradePlan.stance !== "enter" && referenceGeometry === null) {
    gaps.push(
      "本次不提供參考價位：沒有任何組合通過參考價位門檻（回測勝率 ≥55% 且風報比 ≥1:1.5）",
    );
  }

  // 加倉點 — structure-anchored, computed only for a plan that actually enters.
  // Attached after the plan exists because the levels depend on its entry, stop
  // and target, not just on the signal.
  if (
    tradePlan.stance === "enter" &&
    tradePlan.entry !== null &&
    tradePlan.stop_loss !== null &&
    tradePlan.take_profit !== null
  ) {
    const addOns = buildAddOns({
      direction,
      grade,
      entry: tradePlan.entry,
      stopLoss: tradePlan.stop_loss,
      takeProfit: tradePlan.take_profit,
      entryStructures: technical.entryStructures,
      pathObstacles: technical.pathObstacles,
      atr: atrD1,
    });
    tradePlan.add_ons = addOns.levels;
    if (addOns.skipped) {
      gaps.push(`本次不提供加倉點：${addOns.skipped}`);
    }

    // 波段變體 — the same candidate lists at the larger horizon, offered
    // beside the 當沖 plan. Gated on the larger timeframe actually agreeing:
    // holding for days against the D1 trend is the countertrend trade this
    // system does not make, so without a weight-2 technical item pointing the
    // signal's way there is no swing on offer, and the card says why.
    const trendAgrees = biasItems.some(
      (b) => b.dimension === "技術面" && b.direction === direction && b.weight >= 2,
    );
    if (trendAgrees) {
      const swing = selectSwingVariant({
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
        knownGaps: [],
        gradeForcesWait: false,
        candles: d1?.candles,
        atr: atrD1,
      });
      // The identical geometry twice is one plan wearing two labels.
      if (
        swing &&
        (swing.take_profit !== tradePlan.take_profit || swing.stop_loss !== tradePlan.stop_loss)
      ) {
        tradePlan.swing = swing;
      }
    } else {
      gaps.push(
        "本次不提供波段變體：D1 趨勢結構與訊號方向未同向（波段持倉需較大時間框架的趨勢支持）",
      );
    }
  }

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
          undefined,
          meta.symbol,
        )
      : null;
  if (tradePlan.stance === "enter" && !planBacktest) {
    gaps.push("D1 K棒不足，無法對交易計畫做歷史幾何檢驗");
  }

  // Deduped *and* collapsed: one AI outage is one problem, not four. The count
  // feeds the confidence penalty, so double-counting a single cause is not just
  // noisy — it moves the number that decides whether this is tradeable.
  const dedupedGaps = collapseCascades(gaps);

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
    news_digest: news.digest,
    narrative,
    trade_plan: tradePlan,
    plan_backtest: planBacktest,
    interventions,
    direction_tie: tie,
    chart_patterns: chartPatterns,
    market_closed: market.closed,
    market_closed_reason: market.reason,
    graded_as: score.grade,
    reference_plan: referenceGeometry
      ? {
          entry: referenceGeometry.entry,
          stop_loss: referenceGeometry.stopLoss,
          take_profit: referenceGeometry.takeProfit,
          risk_reward: referenceGeometry.riskReward,
          entry_reason: referenceGeometry.entryReason,
          stop_reason: referenceGeometry.stopReason,
          target_reason: referenceGeometry.targetReason,
          basis: referenceGeometry.basis,
          backtest: referenceGeometry.backtest,
        }
      : null,
    downgrades,
    data_gaps: dedupedGaps,
  };

  // 信心度門檻 — the last gate, applied to the assembled signal because the
  // score needs the whole thing: grade, geometry, gap count, backtest.
  //
  // Everything up to here can say "the rules permit this trade". This asks the
  // separate question of whether enough of the system's own evidence actually
  // arrived. A plan that passed every rule on a run where five sources failed
  // is a plan built on a third of its inputs, and calling that a trade is the
  // failure mode this whole codebase keeps trying to avoid.
  //
  // The levels are not discarded. entry_zone / stop_loss / take_profits are
  // separate fields and stay populated, so 完整價位 still shows what the
  // analysis found — labelled as reference, with the shortfall stated.
  // Computed once and stored on the signal, not recomputed at render time.
  // The gate below changes `trade_plan`, and several of the score's own inputs
  // live there — recomputing afterwards would show the reader a different
  // number from the one that made the decision.
  signal.confidence = planConfidence(signal);

  if (signal.trade_plan.stance === "enter" && !clearsEntryBar(signal.confidence.score)) {
    signal.trade_plan = {
      ...signal.trade_plan,
      stance: "wait",
      summary:
        `信心度 ${signal.confidence.score}，未達可交易門檻 ${CONFIDENT_ENTRY_MIN}，暫不進場。` +
        `下方價位仍是分析算出的真實結構，可作為參考與掛單觀察。`,
      wait_for:
        `等信心度升到 ${CONFIDENT_ENTRY_MIN} 以上。目前的扣分項：` +
        (signal.confidence.factors.slice(1).join("；") || "無扣分，但評等基準本身不足"),
      // The three prices described a recommendation that is being withdrawn.
      // entry_zone / stop_loss / take_profits are separate fields and stay, so
      // 完整價位 still shows what the analysis found — as reference, not advice.
      entry: null,
      stop_loss: null,
      take_profit: null,
      risk_reward: null,
      add_ons: [],
    };
  }

  applyLabGate(signal, adoptions, d1?.candles);

  return signal;
}

/**
 * 實驗室閘門 — the last gate, and the only one whose threshold was measured
 * rather than argued.
 *
 * Runs after everything else because it is a veto, not an input: by this point
 * the analysis has already decided what it thinks, and this asks the separate
 * question of whether the entry condition the operator adopted — one that
 * cleared 80% on 100+ trades in-sample *and* held up on history the search
 * never saw — actually holds on the current bar.
 *
 * It can only subtract. If the plan was already a wait, nothing changes and the
 * gate is still attached so the card can show that the requirement is live and
 * being checked. `blocked` marks the one case where this gate is what withdrew
 * the trade, which keeps the reason attributable instead of blurring into the
 * confidence message that may also have applied.
 */
function applyLabGate(
  signal: TradeSignal,
  adoptions: LabAdoption[],
  candles: Candle[] | undefined,
): void {
  // An adoption is scoped to a direction: a long combination says nothing about
  // whether a short is a good idea, so it must not gate one.
  const adoption = findAdoption(adoptions, signal.symbol, signal.direction);
  if (!adoption) return;

  const gate = evaluateAdoption(adoption, candles);
  signal.lab_gate = gate;
  if (gate.met || signal.trade_plan.stance !== "enter") return;

  gate.blocked = true;
  const detail = describeGate(gate);
  signal.trade_plan = {
    ...signal.trade_plan,
    stance: "wait",
    summary:
      `實驗室已採用的進場條件尚未成立（${gate.labels.join(" ＋ ")}），暫不進場。` +
      `這組條件在 ${gate.in_sample_trades} 筆樣本內、${gate.out_of_sample_trades} 筆樣本外` +
      `都達到 ${Math.round(gate.out_of_sample_hit_rate * 100)}% 以上的勝率，` +
      `不符合就等 —— 下方價位仍是分析算出的真實結構，可作為掛單觀察。`,
    wait_for: `等已採用條件全數成立。${detail}`,
    // The three prices described a recommendation that is being withdrawn;
    // entry_zone / stop_loss / take_profits stay, as reference.
    entry: null,
    stop_loss: null,
    take_profit: null,
    risk_reward: null,
    add_ons: [],
  };
}

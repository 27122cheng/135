import type { BiasItem, CommodityMeta, TradeSignal } from "@/types/signal";
import { COMMODITIES } from "@/types/signal";
import { fetchOHLCV } from "./data-sources/ohlcv";
import { atr as computeAtr } from "./analysis/indicators";
import { analyzeTechnical } from "./analysis/technical";
import { analyzeFundamentalXAUUSD } from "./analysis/fundamental";
import { analyzePositioning } from "./analysis/positioning";
import { analyzeNews } from "./analysis/news";
import { analyzeFundFlowXAUUSD } from "./analysis/fundflow";
import { generateNarrative } from "./analysis/ai-narrative";
import { scoreSignal } from "./scoring";
import { buildStopLoss, buildTakeProfits } from "./entry-exit";

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
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
 * End-to-end Stage 1 pipeline for a single symbol. Only XAUUSD is wired to
 * real analyzers today (see CommodityMeta.implemented); calling this for an
 * unimplemented symbol throws, callers should check `implemented` first.
 */
export async function buildTradeSignal(symbol: string): Promise<TradeSignal> {
  const meta = COMMODITIES.find((c) => c.symbol === symbol);
  if (!meta || !meta.implemented) {
    throw new Error(`Symbol ${symbol} is not implemented in Stage 1`);
  }
  return buildXauUsdSignal(meta);
}

async function buildXauUsdSignal(meta: CommodityMeta): Promise<TradeSignal> {
  const gaps: string[] = [];

  const [d1, h4, w1] = await Promise.all([
    fetchOHLCV(meta, "D1", 260, gaps),
    fetchOHLCV(meta, "H4", 260, gaps),
    fetchOHLCV(meta, "W1", 110, gaps),
  ]);

  const candlesByTf = {
    D1: d1?.candles,
    H4: h4?.candles,
    W1: w1?.candles,
  };

  const currentPrice = d1?.candles.at(-1)?.close ?? h4?.candles.at(-1)?.close ?? w1?.candles.at(-1)?.close;
  if (currentPrice == null) {
    gaps.push("所有時框的 OHLCV 皆取得失敗，無法計算即時價位");
    throw new Error("XAUUSD: no OHLCV data available from any source");
  }

  const technical = analyzeTechnical(candlesByTf, currentPrice, gaps);
  const atrD1 = d1 ? computeAtr(d1.candles, 14) : null;
  if (atrD1 == null) gaps.push("D1 K棒不足以計算 ATR(14)");

  const [fundamentalItems, positioning, news, fundFlowItems] = await Promise.all([
    analyzeFundamentalXAUUSD(gaps),
    analyzePositioning("XAUUSD", gaps),
    analyzeNews("gold price OR bullion OR XAUUSD", ["gold", "bullion", "precious metal", "fed", "inflation"], gaps),
    analyzeFundFlowXAUUSD(gaps),
  ]);

  const biasItems: BiasItem[] = [
    ...technical.biasItems,
    ...fundamentalItems,
    ...positioning.biasItems,
    ...news.biasItems,
    ...fundFlowItems,
  ];

  const { direction, tie } = pickDirection(biasItems);
  if (tie) gaps.push("六面向淨方向票數為 0，方向判定採預設 long（僅為平手時的決定規則，非市場訊號）");

  const zoneBuffer = atrD1 && atrD1 > 0 ? atrD1 * 0.15 : currentPrice * 0.0005;
  const entryZone = {
    low: round(currentPrice - zoneBuffer),
    high: round(currentPrice + zoneBuffer),
    reason: atrD1
      ? `即時價位 ${round(currentPrice)} ± 0.15×ATR(14)=${round(zoneBuffer)}`
      : `ATR 不可得，改用即時價位 ${round(currentPrice)} ± 0.05% 作為極小容差`,
  };

  const score = scoreSignal(direction, entryZone, biasItems, technical.entryStructures);

  const stopLoss = buildStopLoss(direction, entryZone, technical.entryStructures, atrD1);
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
    data_gaps: dedupedGaps,
  };

  return signal;
}

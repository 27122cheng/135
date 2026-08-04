import type { BiasItem } from "@/types/signal";
import { fetchFredSeries, type FredPoint } from "../data-sources/fred";

interface Trend {
  direction: "up" | "down" | "flat";
  from: number;
  to: number;
}

function trend(points: FredPoint[], lookback = 10): Trend | null {
  const valid = points.filter((p): p is { date: string; value: number } => p.value !== null);
  if (valid.length < lookback + 1) return null;
  const to = valid.at(-1)!.value;
  const from = valid[valid.length - 1 - lookback].value;
  const pctChange = from === 0 ? 0 : ((to - from) / Math.abs(from)) * 100;
  if (Math.abs(pctChange) < 1) return { direction: "flat", from, to };
  return { direction: pctChange > 0 ? "up" : "down", from, to };
}

/**
 * XAUUSD fundamentals: real interest rate (DGS10 - T10YIE), DXY direction, VIX.
 * Central bank gold-purchase data has no free API in the Stage 1 source list,
 * so it is intentionally omitted and logged to data_gaps rather than guessed.
 */
export async function analyzeFundamentalXAUUSD(gaps: string[]): Promise<BiasItem[]> {
  const items: BiasItem[] = [];
  const [dgs10, t10yie, dxy, vix] = await Promise.all([
    fetchFredSeries("DGS10", gaps),
    fetchFredSeries("T10YIE", gaps),
    fetchFredSeries("DXY", gaps),
    fetchFredSeries("VIX", gaps),
  ]);

  if (dgs10?.latest?.value != null && t10yie?.latest?.value != null) {
    const realRateNow = dgs10.latest.value - t10yie.latest.value;
    const dgs10Trend = trend(dgs10.points);
    const t10yieTrend = trend(t10yie.points);
    if (dgs10Trend && t10yieTrend) {
      const realFrom = dgs10Trend.from - t10yieTrend.from;
      const realTo = dgs10Trend.to - t10yieTrend.to;
      const direction = realTo < realFrom ? "long" : realTo > realFrom ? "short" : "neutral";
      items.push({
        dimension: "基本面",
        factor: `實質利率(DGS10-T10YIE) 現值 ${realRateNow.toFixed(2)}%，近期${direction === "long" ? "下滑" : direction === "short" ? "走高" : "持平"}（實質利率與金價反向）`,
        direction,
        weight: direction === "neutral" ? 0 : 2,
        evidence: `DGS10 ${dgs10Trend.from.toFixed(2)}%→${dgs10Trend.to.toFixed(2)}%, T10YIE ${t10yieTrend.from.toFixed(2)}%→${t10yieTrend.to.toFixed(2)}%`,
        source: `FRED DGS10/T10YIE，最新 ${dgs10.latest.date}`,
      });
    } else {
      gaps.push("DGS10/T10YIE 歷史資料不足以計算實質利率趨勢");
    }
  } else {
    gaps.push("缺少 DGS10 或 T10YIE，無法計算黃金實質利率偏向");
  }

  if (dxy) {
    const dxyTrend = trend(dxy.points);
    if (dxyTrend && dxyTrend.direction !== "flat") {
      const direction = dxyTrend.direction === "down" ? "long" : "short"; // 美元走弱通常利多黃金
      items.push({
        dimension: "基本面",
        factor: `DXY(廣義美元指數) 近期${dxyTrend.direction === "down" ? "走弱" : "走強"} (${dxyTrend.from.toFixed(2)}→${dxyTrend.to.toFixed(2)})`,
        direction,
        weight: 1,
        evidence: `DTWEXBGS ${dxyTrend.from.toFixed(2)}→${dxyTrend.to.toFixed(2)}`,
        source: `FRED DTWEXBGS，最新 ${dxy.latest?.date ?? "N/A"}`,
      });
    }
  }

  if (vix?.latest?.value != null) {
    const v = vix.latest.value;
    if (v >= 25) {
      items.push({
        dimension: "基本面",
        factor: `VIX=${v.toFixed(1)} 處於避險情緒偏高區間，有利黃金避險需求`,
        direction: "long",
        weight: 1,
        evidence: `VIX=${v.toFixed(1)}`,
        source: `FRED VIXCLS，最新 ${vix.latest.date}`,
      });
    } else if (v <= 14) {
      items.push({
        dimension: "基本面",
        factor: `VIX=${v.toFixed(1)} 市場情緒偏低，避險買盤動能弱`,
        direction: "short",
        weight: 1,
        evidence: `VIX=${v.toFixed(1)}`,
        source: `FRED VIXCLS，最新 ${vix.latest.date}`,
      });
    }
  }

  gaps.push("央行購金數據不在 Stage 1 免費 API 清單內，本階段基本面計分不納入此項");

  return items;
}

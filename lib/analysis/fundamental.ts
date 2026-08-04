import type { BiasItem, CommodityMeta } from "@/types/signal";
import type { FundamentalsConfig } from "@/config/fundamentals";
import { fetchFredSeries, type FredPoint } from "../data-sources/fred";
import { fetchEiaCrudeInventory } from "../data-sources/eia";
import { fetchEarningsCalendar } from "../data-sources/finnhub";
import { rateSpreadFor } from "@/config/rate-spreads";
import { analyzeRateSpread } from "./rate-spread";
import { analyzeGoldFlows } from "./gold-flows";

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
 * 基本面，依 config/fundamentals.ts 逐商品套用不同因子組合：
 * XAUUSD → 實質利率(DGS10-T10YIE)、DXY、VIX
 * 美股指數 → DGS10走勢(經DXY近似)、財報季事件風險、VIX
 * WTI → EIA庫存、DXY（OPEC消息由新聞面關鍵字涵蓋）
 * 外匯 → DXY（兩國利差因缺乏外國公債資料暫不納入，見 data_gaps）
 */
export async function analyzeFundamental(
  meta: CommodityMeta,
  config: FundamentalsConfig,
  gaps: string[],
): Promise<BiasItem[]> {
  const items: BiasItem[] = [];

  const [dgs10, t10yie, dxy, vix, eia, earnings] = await Promise.all([
    config.useRealRate ? fetchFredSeries("DGS10", gaps) : Promise.resolve(null),
    config.useRealRate ? fetchFredSeries("T10YIE", gaps) : Promise.resolve(null),
    config.useDxy ? fetchFredSeries("DXY", gaps) : Promise.resolve(null),
    config.useVix ? fetchFredSeries("VIX", gaps) : Promise.resolve(null),
    config.useEiaInventory ? fetchEiaCrudeInventory(gaps) : Promise.resolve(null),
    config.useEarningsSeason ? fetchEarningsCalendar(gaps) : Promise.resolve(null),
  ]);

  if (config.useRealRate) {
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
      gaps.push("缺少 DGS10 或 T10YIE，無法計算實質利率偏向");
    }
  }

  if (config.useDxy && dxy) {
    const dxyTrend = trend(dxy.points);
    if (dxyTrend && dxyTrend.direction !== "flat") {
      const dxyDown = dxyTrend.direction === "down";
      const direction = dxyDown !== config.dxyInverted ? "long" : "short";
      items.push({
        dimension: "基本面",
        factor: `DXY(廣義美元指數) 近期${dxyDown ? "走弱" : "走強"} (${dxyTrend.from.toFixed(2)}→${dxyTrend.to.toFixed(2)})`,
        direction,
        weight: 1,
        evidence: `DTWEXBGS ${dxyTrend.from.toFixed(2)}→${dxyTrend.to.toFixed(2)}`,
        source: `FRED DTWEXBGS，最新 ${dxy.latest?.date ?? "N/A"}`,
      });
    }
  }

  if (config.useVix && vix?.latest?.value != null) {
    const v = vix.latest.value;
    if (v >= 25 || v <= 14) {
      const riskOff = v >= 25;
      const direction = riskOff
        ? config.vixRiskOffDirection
        : config.vixRiskOffDirection === "long"
          ? "short"
          : "long";
      items.push({
        dimension: "基本面",
        factor: `VIX=${v.toFixed(1)} ${riskOff ? "風險趨避情緒偏高" : "風險偏好情緒偏高，避險需求弱"}`,
        direction,
        weight: 1,
        evidence: `VIX=${v.toFixed(1)}`,
        source: `FRED VIXCLS，最新 ${vix.latest.date}`,
      });
    }
  }

  if (config.useEiaInventory) {
    if (eia) {
      const change = eia.latest.value - (eia.previous?.value ?? eia.latest.value);
      items.push({
        dimension: "基本面",
        factor: `EIA 原油庫存週變化 ${change >= 0 ? "+" : ""}${change.toLocaleString()} 千桶`,
        direction: change < 0 ? "long" : change > 0 ? "short" : "neutral",
        weight: change === 0 ? 0 : 1,
        evidence: `${eia.previous?.value.toLocaleString() ?? "N/A"} (${eia.previous?.period ?? "N/A"}) → ${eia.latest.value.toLocaleString()} (${eia.latest.period})`,
        source: eia.source === "eia" ? "EIA petroleum/stoc/wstk weekly" : "FRED WCESTUS1（EIA 原始資料）",
      });
    }
  }

  if (config.useEarningsSeason && earnings && earnings.length > 0) {
    items.push({
      dimension: "基本面",
      factor: `未來7天內有 ${earnings.length} 筆財報事件，波動風險上升`,
      direction: "neutral",
      weight: 0,
      evidence: `${earnings.length} 筆財報事件`,
      source: "Finnhub /calendar/earnings",
    });
  }

  // 央行購金與黃金實體流向 — DBnomics gives one keyless API over IMF and the
  // national central banks, so this no longer needs a paid source. Each source
  // becomes its own factor with a frequency-capped weight; see gold-flows.ts.
  if (meta.symbol === "XAUUSD") {
    const flows = await analyzeGoldFlows(gaps);
    items.push(...flows.items);
  }
  // 兩國利差 — FRED only covers US Treasuries, so the foreign legs come from
  // Stooq's daily CSV / the ECB portal. See lib/analysis/rate-spread.ts.
  const spreadConfig = rateSpreadFor(meta.symbol);
  if (spreadConfig) {
    items.push(...(await analyzeRateSpread(spreadConfig, gaps)));
  }

  return items;
}

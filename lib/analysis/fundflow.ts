import type { BiasItem, CommodityMeta } from "@/types/signal";
import type { FundamentalsConfig } from "@/config/fundamentals";
import type { CotReport } from "../data-sources/cftc";
import { fetchEtfFlow, fetchGldHoldings } from "../data-sources/etf";
import { fetchFredSeries, type FredPoint } from "../data-sources/fred";

function trendPct(points: FredPoint[], lookback: number): { from: number; to: number; pct: number } | null {
  const valid = points.filter((p): p is { date: string; value: number } => p.value !== null);
  if (valid.length < lookback + 1) return null;
  const to = valid.at(-1)!.value;
  const from = valid[valid.length - 1 - lookback].value;
  return { from, to, pct: from === 0 ? 0 : ((to - from) / Math.abs(from)) * 100 };
}

/**
 * 資金流：ETF持倉（僅設定 etfHoldings 的商品）、COT 未平倉量週變化、DXY方向、VIX風險情緒。
 * `cotReports` 由呼叫端（signal-builder）傳入，重用籌碼面已抓取的同一批 COT 資料，避免重複請求。
 */
export async function analyzeFundFlow(
  meta: CommodityMeta,
  config: FundamentalsConfig,
  cotReports: CotReport[] | null,
  gaps: string[],
): Promise<BiasItem[]> {
  const items: BiasItem[] = [];

  if (config.etfHoldings === "GLD") {
    // Volume-based flow first: it has history, so it can carry a direction.
    // The holdings snapshot is a bonus line when the feed is reachable.
    const [flow, gld] = await Promise.all([
      fetchEtfFlow("GLD", gaps),
      fetchGldHoldings(gaps),
    ]);

    if (flow) {
      // Only an expansion counts. Volume drying up says the crowd left, which
      // is not a directional statement about where price goes next.
      const expanding = flow.volumeChangePct >= 20;
      const movedUp = flow.priceChangePct > 0.3;
      const movedDown = flow.priceChangePct < -0.3;
      if (expanding && (movedUp || movedDown)) {
        items.push({
          dimension: "資金流",
          factor:
            `GLD 近 ${flow.recentDays} 日均量較前 ${flow.baselineDays} 日放大 ` +
            `${flow.volumeChangePct.toFixed(0)}%，同期價格${movedUp ? "上漲" : "下跌"} ` +
            `${Math.abs(flow.priceChangePct).toFixed(1)}%（${movedUp ? "買盤進場" : "賣壓出場"}）`,
          direction: movedUp ? "long" : "short",
          weight: 1,
          evidence:
            `近${flow.recentDays}日均量 vs 前${flow.baselineDays}日均量 ` +
            `${flow.volumeChangePct >= 0 ? "+" : ""}${flow.volumeChangePct.toFixed(1)}%，` +
            `價格 ${flow.priceChangePct >= 0 ? "+" : ""}${flow.priceChangePct.toFixed(2)}%`,
          // Named as a proxy wherever it appears — share volume is trading
          // activity, not creations and redemptions.
          source: "GLD 日線成交量（yfinance 代理）— 資金流代理指標，非實際持倉",
        });
      }
    }

    if (gld) {
      items.push({
        dimension: "資金流",
        key: "gld-holdings",
        factor: `SPDR GLD 持倉 ${gld.tonnesInTrust.toLocaleString()} 噸 (${gld.asOf})`,
        direction: "neutral",
        weight: 0,
        evidence: `tonnesInTrust=${gld.tonnesInTrust}（單次快照，無歷史基準可比較）`,
        source: `SPDR GLD 官方持倉 XML, ${gld.asOf}`,
      });
    }
  }

  // 未平倉量 is analyzed in lib/analysis/open-interest.ts, which needs price
  // alongside the COT data — the caller runs it once both have resolved.

  if (config.useDxy) {
    const dxy = await fetchFredSeries("DXY", gaps);
    if (dxy) {
      const t = trendPct(dxy.points, 5);
      if (t && Math.abs(t.pct) >= 0.3) {
        const dxyDown = t.pct < 0;
        const direction = dxyDown !== config.dxyInverted ? "long" : "short";
        items.push({
          dimension: "資金流",
          key: "usd-dxy-trend",
          factor: `DXY 近5個交易日${dxyDown ? "走弱" : "走強"} (${t.from.toFixed(2)}→${t.to.toFixed(2)})`,
          direction,
          weight: 1,
          evidence: `DTWEXBGS ${t.from.toFixed(2)}→${t.to.toFixed(2)}`,
          source: `FRED DTWEXBGS, 最新 ${dxy.latest?.date ?? "N/A"}`,
        });
      }
    }
  }

  if (config.useVix) {
    const vix = await fetchFredSeries("VIX", gaps);
    if (vix?.latest?.value != null) {
      const v = vix.latest.value;
      if (v >= 25 || v <= 14) {
        const riskOff = v >= 25;
        const direction = riskOff
          ? config.vixRiskOffDirection
          : config.vixRiskOffDirection === "long"
            ? "short"
            : "long";
        items.push({
          dimension: "資金流",
          key: "risk-vix-level",
          factor: `VIX=${v.toFixed(1)} ${riskOff ? "風險趨避提升避險/拋售壓力" : "風險偏好高避險買盤弱"}`,
          direction,
          weight: 1,
          evidence: `VIX=${v.toFixed(1)}`,
          source: `FRED VIXCLS, 最新 ${vix.latest.date}`,
        });
      }
    }
  }

  return items;
}

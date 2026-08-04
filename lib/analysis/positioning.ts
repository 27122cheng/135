import type { BiasItem, CommodityMeta } from "@/types/signal";
import type { FundamentalsConfig } from "@/config/fundamentals";
import { fetchCotReport, type CotReport } from "../data-sources/cftc";

export interface PositioningResult {
  biasItems: BiasItem[];
  reports: CotReport[] | null;
}

/** 籌碼面：CFTC COT 非商業淨部位方向、52週極端值、週變化。*/
export async function analyzePositioning(
  meta: CommodityMeta,
  config: FundamentalsConfig,
  gaps: string[],
): Promise<PositioningResult> {
  if (!config.cotContractCode) {
    gaps.push(`${meta.symbol} 無對應的 CFTC COT 合約代碼（可能在美國以外的交易所交易），籌碼面本階段從缺`);
    return { biasItems: [], reports: null };
  }
  const reports = await fetchCotReport(meta.symbol, config.cotContractCode, gaps);
  if (!reports || reports.length === 0) {
    return { biasItems: [], reports };
  }
  const invert = config.cotInverted ? -1 : 1;
  const items: BiasItem[] = [];
  const latest = reports.at(-1)!;
  const latestNetSigned = latest.netNonCommercial * invert;
  const direction = latestNetSigned > 0 ? "long" : latestNetSigned < 0 ? "short" : "neutral";
  items.push({
    dimension: "籌碼面",
    factor: `CFTC COT 非商業淨部位 ${latest.netNonCommercial.toLocaleString()} 口 (${latest.reportDate})${config.cotInverted ? "（合約方向與報價相反，已反轉計分）" : ""}`,
    direction,
    weight: direction === "neutral" ? 0 : 2,
    evidence: `long ${latest.noncommercialLong.toLocaleString()} / short ${latest.noncommercialShort.toLocaleString()}, net ${latest.netNonCommercial.toLocaleString()}`,
    source: `CFTC Socrata 6dca-aqww, ${latest.reportDate}`,
  });

  const window = reports.slice(-52);
  if (window.length >= 10) {
    const nets = window.map((r) => r.netNonCommercial);
    const maxNet = Math.max(...nets);
    const minNet = Math.min(...nets);
    if (latest.netNonCommercial === maxNet) {
      items.push({
        dimension: "籌碼面",
        factor: `非商業淨部位處於近 ${window.length} 週最高，籌碼過度偏多需留意獲利了結風險`,
        direction: invert > 0 ? "short" : "long",
        weight: 1,
        evidence: `net=${latest.netNonCommercial.toLocaleString()}, ${window.length}週區間 [${minNet.toLocaleString()}, ${maxNet.toLocaleString()}]`,
        source: `CFTC Socrata 6dca-aqww, ${latest.reportDate}`,
      });
    } else if (latest.netNonCommercial === minNet) {
      items.push({
        dimension: "籌碼面",
        factor: `非商業淨部位處於近 ${window.length} 週最低，籌碼過度偏空可能出現反彈`,
        direction: invert > 0 ? "long" : "short",
        weight: 1,
        evidence: `net=${latest.netNonCommercial.toLocaleString()}, ${window.length}週區間 [${minNet.toLocaleString()}, ${maxNet.toLocaleString()}]`,
        source: `CFTC Socrata 6dca-aqww, ${latest.reportDate}`,
      });
    }
  } else {
    gaps.push(`CFTC COT (${meta.symbol}) 歷史週數不足 10 週，無法判斷是否處於極端值`);
  }

  if (reports.length >= 2) {
    const prev = reports.at(-2)!;
    const weeklyChange = (latest.netNonCommercial - prev.netNonCommercial) * invert;
    items.push({
      dimension: "籌碼面",
      factor: `非商業淨部位週變化 ${weeklyChange >= 0 ? "+" : ""}${weeklyChange.toLocaleString()} 口`,
      direction: weeklyChange > 0 ? "long" : weeklyChange < 0 ? "short" : "neutral",
      weight: weeklyChange === 0 ? 0 : 1,
      evidence: `${prev.netNonCommercial.toLocaleString()} (${prev.reportDate}) → ${latest.netNonCommercial.toLocaleString()} (${latest.reportDate})`,
      source: "CFTC Socrata 6dca-aqww",
    });
  } else {
    gaps.push(`CFTC COT (${meta.symbol}) 不足兩週資料，無法計算週變化`);
  }

  return { biasItems: items, reports };
}

import type { BiasItem, CommodityMeta } from "@/types/signal";
import type { FundamentalsConfig } from "@/config/fundamentals";
import { fetchCotReport, type CotReport } from "../data-sources/cftc";

export interface PositioningResult {
  biasItems: BiasItem[];
  reports: CotReport[] | null;
  /**
   * Direction the 52-week COT extreme argues for (the mean-reversion side), or
   * null when positioning isn't at an extreme. Surfaced as a flag rather than
   * left for callers to string-match the bias item, because the S8 intervention
   * ("COT 處於極端且方向相反時直接 no-trade") depends on reading it correctly.
   */
  extremeDirection: "long" | "short" | null;
}

/** 籌碼面：CFTC COT 非商業淨部位方向、52週極端值、週變化。*/
export async function analyzePositioning(
  meta: CommodityMeta,
  config: FundamentalsConfig,
  gaps: string[],
): Promise<PositioningResult> {
  if (!config.cotContractCode) {
    gaps.push(`${meta.symbol} 無對應的 CFTC COT 合約代碼（可能在美國以外的交易所交易），籌碼面本階段從缺`);
    return { biasItems: [], reports: null, extremeDirection: null };
  }
  const reports = await fetchCotReport(meta.symbol, config.cotContractCode, gaps);
  if (!reports || reports.length === 0) {
    return { biasItems: [], reports, extremeDirection: null };
  }
  const invert = config.cotInverted ? -1 : 1;
  const items: BiasItem[] = [];
  const latest = reports.at(-1)!;
  // 報告過舊就不投票. COT is weekly (Tuesday positions, Friday release), so
  // the newest report is normally 3–10 days old. Older than that means a
  // missed release or a stale cache, and positioning from three weeks ago
  // is not a vote about this week — it is shown, at weight 0, with its age.
  const COT_MAX_AGE_DAYS = 14;
  const reportMs = Date.parse(`${latest.reportDate}T00:00:00Z`);
  const ageDays = Number.isFinite(reportMs) ? Math.floor((Date.now() - reportMs) / 86_400_000) : null;
  const stale = ageDays !== null && ageDays > COT_MAX_AGE_DAYS;
  if (stale) {
    gaps.push(`CFTC COT (${meta.symbol}) 最新報告已 ${ageDays} 天（超過 ${COT_MAX_AGE_DAYS} 天），籌碼面本次僅供參考、不投票`);
  }
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

  let extremeDirection: "long" | "short" | null = null;
  const window = reports.slice(-52);
  if (window.length >= 10) {
    const nets = window.map((r) => r.netNonCommercial);
    const maxNet = Math.max(...nets);
    const minNet = Math.min(...nets);
    if (latest.netNonCommercial === maxNet) {
      extremeDirection = invert > 0 ? "short" : "long";
      items.push({
        dimension: "籌碼面",
        factor: `非商業淨部位處於近 ${window.length} 週最高，籌碼過度偏多需留意獲利了結風險`,
        direction: invert > 0 ? "short" : "long",
        weight: 1,
        evidence: `net=${latest.netNonCommercial.toLocaleString()}, ${window.length}週區間 [${minNet.toLocaleString()}, ${maxNet.toLocaleString()}]`,
        source: `CFTC Socrata 6dca-aqww, ${latest.reportDate}`,
      });
    } else if (latest.netNonCommercial === minNet) {
      extremeDirection = invert > 0 ? "long" : "short";
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

  if (stale) {
    for (const it of items) {
      if (it.weight > 0) {
        it.weight = 0;
        it.factor = `${it.factor}（報告已 ${ageDays} 天，權重歸零）`;
      }
    }
  }
  return { biasItems: items, reports, extremeDirection };
}

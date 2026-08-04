import type { BiasItem } from "@/types/signal";
import { fetchGldHoldings } from "../data-sources/etf";
import { fetchCotReport } from "../data-sources/cftc";
import { fetchFredSeries } from "../data-sources/fred";

/** 資金流：ETF持倉、未平倉量變化(COT)、DXY方向、VIX風險情緒。*/
export async function analyzeFundFlowXAUUSD(gaps: string[]): Promise<BiasItem[]> {
  const items: BiasItem[] = [];

  const [gld, cot, dxy, vix] = await Promise.all([
    fetchGldHoldings(gaps),
    fetchCotReport("XAUUSD", gaps),
    fetchFredSeries("DXY", gaps),
    fetchFredSeries("VIX", gaps),
  ]);

  if (gld) {
    items.push({
      dimension: "資金流",
      factor: `SPDR GLD 持倉 ${gld.tonnesInTrust.toLocaleString()} 噸 (${gld.asOf})`,
      direction: "neutral",
      weight: 0,
      evidence: `tonnesInTrust=${gld.tonnesInTrust}`,
      source: `SPDR GLD 官方持倉 XML, ${gld.asOf}`,
    });
    gaps.push("GLD 持倉變化需要歷史基準，Stage 1 僅取得單次快照，暫不計入方向分數（僅供參考）");
  }

  if (cot && cot.length >= 2) {
    const latest = cot.at(-1)!;
    const prev = cot.at(-2)!;
    const oiChange = latest.openInterest - prev.openInterest;
    items.push({
      dimension: "資金流",
      factor: `COMEX 黃金未平倉量週變化 ${oiChange >= 0 ? "+" : ""}${oiChange.toLocaleString()} 口`,
      direction:
        oiChange > 0 && latest.netNonCommercial >= 0
          ? "long"
          : oiChange < 0 && latest.netNonCommercial < 0
            ? "short"
            : "neutral",
      weight: oiChange === 0 ? 0 : 1,
      evidence: `open interest ${prev.openInterest.toLocaleString()} (${prev.reportDate}) → ${latest.openInterest.toLocaleString()} (${latest.reportDate})`,
      source: "CFTC Socrata 6dca-aqww",
    });
  }

  if (dxy) {
    const valid = dxy.points.filter((p): p is { date: string; value: number } => p.value !== null);
    if (valid.length >= 6) {
      const to = valid.at(-1)!.value;
      const from = valid[valid.length - 6].value;
      const pct = from === 0 ? 0 : ((to - from) / Math.abs(from)) * 100;
      if (Math.abs(pct) >= 0.3) {
        items.push({
          dimension: "資金流",
          factor: `DXY 近5個交易日${pct < 0 ? "走弱" : "走強"} (${from.toFixed(2)}→${to.toFixed(2)})`,
          direction: pct < 0 ? "long" : "short",
          weight: 1,
          evidence: `DTWEXBGS ${from.toFixed(2)}→${to.toFixed(2)}`,
          source: `FRED DTWEXBGS, 最新 ${dxy.latest?.date ?? "N/A"}`,
        });
      }
    }
  }

  if (vix?.latest?.value != null) {
    const v = vix.latest.value;
    items.push({
      dimension: "資金流",
      factor: `VIX=${v.toFixed(1)} ${v >= 25 ? "風險趨避提升避險買盤" : v <= 14 ? "風險偏好高避險買盤弱" : "中性"}`,
      direction: v >= 25 ? "long" : v <= 14 ? "short" : "neutral",
      weight: v >= 25 || v <= 14 ? 1 : 0,
      evidence: `VIX=${v.toFixed(1)}`,
      source: `FRED VIXCLS, 最新 ${vix.latest.date}`,
    });
  }

  return items;
}

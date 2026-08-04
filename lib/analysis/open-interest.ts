import type { BiasItem, CommodityMeta } from "@/types/signal";
import type { CotReport } from "../data-sources/cftc";
import type { Candle } from "../data-sources/ohlcv";

/**
 * 未平倉量 (open interest) analysis, from the CFTC COT reports already fetched
 * for 籌碼面 — no extra request and no API key.
 *
 * Important limitation: CFTC open interest is **weekly**, measured Tuesday and
 * published Friday, so it lags price by up to ~3 trading days. It is a
 * participation/conviction measure over the week, not an intraday signal.
 * Everything below is scoped to that cadence and says so in its evidence.
 */

/** The four quadrants of the classic price/open-interest matrix. */
type Quadrant = "price_up_oi_up" | "price_up_oi_down" | "price_down_oi_up" | "price_down_oi_down";

interface QuadrantRule {
  /** Direction the quadrant argues for. */
  direction: "long" | "short";
  /** Confirmation reads carry more weight than exhaustion reads. */
  weight: 1 | 2;
  label: string;
  reading: string;
}

const QUADRANTS: Record<Quadrant, QuadrantRule> = {
  price_up_oi_up: {
    direction: "long",
    weight: 2,
    label: "價漲量增",
    reading: "新資金進場推升，漲勢有新買盤支撐，趨勢確認",
  },
  price_down_oi_up: {
    direction: "short",
    weight: 2,
    label: "價跌量增",
    reading: "新空單進場推跌，跌勢有新賣壓支撐，趨勢確認",
  },
  price_up_oi_down: {
    // A rally on shrinking OI is short covering, not new buying — a caution
    // against the up move, so it argues the opposite way at lower weight.
    direction: "short",
    weight: 1,
    label: "價漲量減",
    reading: "空頭回補推升而非新買盤進場，漲勢缺乏新資金，動能存疑",
  },
  price_down_oi_down: {
    direction: "long",
    weight: 1,
    label: "價跌量減",
    reading: "多頭平倉離場而非新空單進場，賣壓正在耗盡，跌勢動能減弱",
  },
};

/** Last close at or before `date`; null when the candles don't reach back that far. */
function closeOnOrBefore(candles: Candle[], date: string): number | null {
  const cutoff = new Date(`${date}T23:59:59Z`).getTime();
  let found: number | null = null;
  for (const c of candles) {
    if (new Date(c.time).getTime() <= cutoff) found = c.close;
    else break;
  }
  return found;
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function analyzeOpenInterest(
  meta: CommodityMeta,
  reports: CotReport[] | null,
  candles: Candle[] | null,
  gaps: string[],
): BiasItem[] {
  if (!reports || reports.length < 2) {
    gaps.push(`${meta.symbol} COT 資料不足兩週，無法分析未平倉量`);
    return [];
  }

  const items: BiasItem[] = [];
  const latest = reports.at(-1)!;
  const prev = reports.at(-2)!;
  const oiChange = latest.openInterest - prev.openInterest;
  const oiChangePct = prev.openInterest > 0 ? (oiChange / prev.openInterest) * 100 : 0;

  // 1) Price/OI matrix — the core read. Needs price over the same two dates.
  if (!candles || candles.length === 0) {
    gaps.push("缺少 D1 K棒，無法做價量未平倉交叉分析（僅能看未平倉量本身變化）");
  } else {
    const priceLatest = closeOnOrBefore(candles, latest.reportDate);
    const pricePrev = closeOnOrBefore(candles, prev.reportDate);
    if (priceLatest == null || pricePrev == null) {
      gaps.push(
        `D1 K棒未涵蓋 COT 報告日期區間 (${prev.reportDate} ~ ${latest.reportDate})，無法做價量未平倉交叉分析`,
      );
    } else {
      const priceChange = priceLatest - pricePrev;
      const priceChangePct = pricePrev !== 0 ? (priceChange / pricePrev) * 100 : 0;
      // Both moves must be non-trivial for the quadrant to mean anything.
      const priceMoved = Math.abs(priceChangePct) >= 0.3;
      const oiMoved = Math.abs(oiChangePct) >= 1;

      if (!priceMoved || !oiMoved) {
        items.push({
          dimension: "資金流",
          factor: `價量未平倉關係不明確（價格 ${priceChangePct.toFixed(2)}%、未平倉量 ${oiChangePct.toFixed(2)}%，變動過小）`,
          direction: "neutral",
          weight: 0,
          evidence: `價格 ${pricePrev} → ${priceLatest}（${priceChangePct.toFixed(2)}%），未平倉量 ${prev.openInterest.toLocaleString()} → ${latest.openInterest.toLocaleString()}（${oiChangePct.toFixed(2)}%）`,
          source: `CFTC Socrata 6dca-aqww + D1 收盤價，${prev.reportDate}~${latest.reportDate}`,
        });
      } else {
        const quadrant: Quadrant =
          priceChange > 0
            ? oiChange > 0
              ? "price_up_oi_up"
              : "price_up_oi_down"
            : oiChange > 0
              ? "price_down_oi_up"
              : "price_down_oi_down";
        const rule = QUADRANTS[quadrant];
        items.push({
          dimension: "資金流",
          factor: `${rule.label}：${rule.reading}`,
          direction: rule.direction,
          weight: rule.weight,
          evidence: `價格 ${pricePrev} → ${priceLatest}（${priceChangePct >= 0 ? "+" : ""}${priceChangePct.toFixed(2)}%），未平倉量 ${prev.openInterest.toLocaleString()} → ${latest.openInterest.toLocaleString()}（${oiChangePct >= 0 ? "+" : ""}${oiChangePct.toFixed(2)}%）`,
          source: `CFTC Socrata 6dca-aqww + D1 收盤價，週期 ${prev.reportDate}~${latest.reportDate}`,
        });
      }
    }
  }

  // 2) Where current OI sits in its own 52-week range — participation extreme.
  const window = reports.slice(-52);
  if (window.length >= 20) {
    const ois = window.map((r) => r.openInterest);
    const maxOi = Math.max(...ois);
    const minOi = Math.min(...ois);
    const range = maxOi - minOi;
    const pct = range > 0 ? ((latest.openInterest - minOi) / range) * 100 : 50;
    if (pct >= 90 || pct <= 10) {
      items.push({
        dimension: "資金流",
        factor:
          pct >= 90
            ? `未平倉量處於近 ${window.length} 週高位（第 ${pct.toFixed(0)} 百分位），市場參與度極高、部位擁擠`
            : `未平倉量處於近 ${window.length} 週低位（第 ${pct.toFixed(0)} 百分位），市場參與度低、缺乏推動力`,
        // Crowding and apathy are both risk flags, not directional calls.
        direction: "neutral",
        weight: 0,
        evidence: `未平倉量 ${latest.openInterest.toLocaleString()}，${window.length}週區間 [${minOi.toLocaleString()}, ${maxOi.toLocaleString()}]`,
        source: `CFTC Socrata 6dca-aqww, ${latest.reportDate}`,
      });
    }
  } else {
    gaps.push(`COT 歷史不足 20 週，無法判斷未平倉量是否處於極端水位`);
  }

  // 3) Surge detection — this week's change against the recent distribution.
  if (reports.length >= 10) {
    const changes: number[] = [];
    for (let i = 1; i < reports.length; i++) {
      changes.push(reports[i].openInterest - reports[i - 1].openInterest);
    }
    const priorChanges = changes.slice(0, -1);
    const sd = stdev(priorChanges);
    const meanAbs =
      priorChanges.reduce((sum, v) => sum + Math.abs(v), 0) / priorChanges.length;

    let magnitude: string | null = null;
    let evidence = "";
    if (sd > 0) {
      const zScore = oiChange / sd;
      if (Math.abs(zScore) >= 2) {
        magnitude = `${zScore.toFixed(1)}σ`;
        evidence = `本週變化 ${oiChange >= 0 ? "+" : ""}${oiChange.toLocaleString()} 口，歷史週變化標準差 ${Math.round(sd).toLocaleString()} 口`;
      }
    } else if (meanAbs > 0 && Math.abs(oiChange) >= meanAbs * 5) {
      // Zero variance in prior weeks makes a z-score undefined; fall back to a
      // ratio against the average weekly move so a real spike isn't missed.
      magnitude = `為歷史平均週變化的 ${(Math.abs(oiChange) / meanAbs).toFixed(1)} 倍`;
      evidence = `本週變化 ${oiChange >= 0 ? "+" : ""}${oiChange.toLocaleString()} 口，歷史平均週變化 ${Math.round(meanAbs).toLocaleString()} 口（歷史變化無波動，改用倍數判定）`;
    }

    if (magnitude) {
      items.push({
        dimension: "資金流",
        factor: `未平倉量異常${oiChange > 0 ? "激增" : "驟減"}（${magnitude}），資金流出現非常態變化`,
        direction: "neutral",
        weight: 0,
        evidence,
        source: `CFTC Socrata 6dca-aqww，${reports.length} 週樣本`,
      });
    }
  }

  return items;
}

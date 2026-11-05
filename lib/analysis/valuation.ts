import type { BiasItem, CommodityMeta } from "@/types/signal";
import type { Valuation } from "../data-sources/valuation";

/**
 * 估值因子 — what the multiple says about the tide under an index trade.
 *
 * Two reads, both slow and both anchored to a number the reader can check:
 *
 *  - **股權風險溢酬 (ERP)**: earnings yield minus the 10-year yield. Below
 *    ERP_THIN the bond pays as much as stocks with none of the drawdown, and
 *    the index has to keep growing earnings just to stand still — a
 *    headwind for longs. Above ERP_RICH, stocks are cheap against bonds.
 *  - **估值位階**: today's P/E against the last ten years of monthly prints.
 *    At the 90th percentile the market is priced for a lot to go right.
 *
 * Both vote at weight 1 at the extremes and sit at 0 in the middle: a
 * multiple is a condition, not a trigger, and it must never pick the day.
 * For GER40 the US multiple is a proxy and votes nothing.
 *
 * 財報季 also lives here as a keyless clock fallback: the four reporting
 * windows are known in advance, so a missing Finnhub key should not blank
 * the one calendar fact every index trader keeps in their head.
 */

export const ERP_THIN = 1.0;
export const ERP_RICH = 3.0;
export const PE_PERCENTILE_HIGH = 90;
export const PE_PERCENTILE_LOW = 10;

const r2 = (n: number) => Math.round(n * 100) / 100;

export function pePercentile(pe: number, history: Array<{ pe: number }>): number | null {
  const sample = history.slice(-120).map((h) => h.pe).filter((v) => Number.isFinite(v));
  if (sample.length < 36) return null;
  return Math.round((sample.filter((v) => v < pe).length / sample.length) * 100);
}

/** 財報季 by the calendar: roughly the 12th of Jan/Apr/Jul/Oct to the 15th of the next month. */
export function inEarningsSeason(now: Date): { active: boolean; label: string } {
  const m = now.getUTCMonth(); // 0-based
  const d = now.getUTCDate();
  const starts = [0, 3, 6, 9];
  for (const s of starts) {
    const q = Math.floor(s / 3) + 1;
    if ((m === s && d >= 12) || (m === s + 1 && d <= 15)) return { active: true, label: `Q${q === 1 ? 4 : q - 1} 財報季` };
  }
  return { active: false, label: "非財報季" };
}

export function analyzeValuation(
  meta: CommodityMeta,
  valuation: Valuation | null,
  dgs10: number | null,
  now = new Date(),
  hasEarningsCalendar = false,
): BiasItem[] {
  if (meta.category !== "index") return [];
  const items: BiasItem[] = [];
  const proxy = meta.symbol === "GER40";
  const proxyNote = proxy ? "（以美股本益比代理，DAX 無免費估值來源，只顯示不投票）" : "";

  if (valuation) {
    const src =
      valuation.source === "multpl" ? "multpl.com" : valuation.source === "nasdaq-data-link" ? "Nasdaq Data Link MULTPL" : "Finviz SPY";
    if (dgs10 !== null) {
      const erp = r2(valuation.earningsYieldPct - dgs10);
      const thin = erp < ERP_THIN;
      const rich = erp > ERP_RICH;
      items.push({
        dimension: "基本面",
        key: "valuation-erp",
        factor:
          `股權風險溢酬 ${erp > 0 ? "+" : ""}${erp}%（盈餘殖利率 ${valuation.earningsYieldPct}% − 美債10年 ${r2(dgs10)}%）` +
          (thin ? "：債券替代性強，估值偏貴" : rich ? "：股票相對債券便宜" : "：中性區間") + proxyNote,
        direction: thin ? "short" : rich ? "long" : "neutral",
        weight: proxy || (!thin && !rich) ? 0 : 1,
        evidence: `本益比 ${valuation.pe}，盈餘殖利率 1/PE = ${valuation.earningsYieldPct}%；門檻 <${ERP_THIN}% 偏空、>${ERP_RICH}% 偏多`,
        source: `${src} + FRED DGS10，${valuation.asOf.slice(0, 10)}`,
      });
    }
    const pct = pePercentile(valuation.pe, valuation.history);
    if (pct !== null) {
      const high = pct >= PE_PERCENTILE_HIGH;
      const low = pct <= PE_PERCENTILE_LOW;
      items.push({
        dimension: "基本面",
        key: "valuation-percentile",
        factor:
          `本益比 ${valuation.pe}，十年位階 ${pct}%` +
          (high ? "：接近歷史頂部估值" : low ? "：接近歷史底部估值" : "：歷史中段") + proxyNote,
        direction: high ? "short" : low ? "long" : "neutral",
        weight: proxy || (!high && !low) ? 0 : 1,
        evidence: `近 ${Math.min(120, valuation.history.length)} 個月的月度本益比中，低於目前值的占 ${pct}%`,
        source: `${src}，${valuation.asOf.slice(0, 10)}`,
      });
    } else {
      items.push({
        dimension: "基本面",
        key: "valuation-percentile",
        factor: `本益比 ${valuation.pe}（來源無歷史，無法算位階）${proxyNote}`,
        direction: "neutral",
        weight: 0,
        evidence: `盈餘殖利率 ${valuation.earningsYieldPct}%`,
        source: `${src}，${valuation.asOf.slice(0, 10)}`,
      });
    }
  }

  if (!hasEarningsCalendar) {
    const season = inEarningsSeason(now);
    if (season.active) {
      items.push({
        dimension: "基本面",
        key: "earnings-season",
        factor: `${season.label}（以日曆推算）：個股財報密集，指數波動與跳空風險上升`,
        direction: "neutral",
        weight: 0,
        evidence: "每季 12 日起至次月 15 日為美股財報密集期；未設 Finnhub 金鑰時以日曆代替",
        source: "日曆推算",
      });
    }
  }
  return items;
}

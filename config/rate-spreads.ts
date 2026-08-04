import type { FredLabel } from "@/lib/data-sources/fred";

/**
 * 兩國利差 — which yield pair drives which symbol.
 *
 * The short end, not the long end: FX is driven mainly by 2Y differentials
 * because those track the expected policy path. 10Y spreads mostly reflect
 * growth and term premium expectations, which move the currency far less
 * directly. USDJPY is the exception — the BOJ has controlled the JGB long end
 * outright, so the 10Y differential is the one that carries policy information.
 *
 * Symbols not listed here don't get a spread factor at all. Equity indices and
 * WTI are not primarily rate-differential instruments, and XAUUSD already has a
 * better-suited factor in the US real rate (DGS10 − T10YIE).
 */

export interface YieldLegSource {
  /** Human label used in the bias item's evidence. */
  label: string;
  /**
   * Stooq daily yield code. The 10Y codes come from the spec; the 2Y codes
   * follow the same documented naming pattern but could not be verified live
   * from the build sandbox. A wrong code returns no rows and falls through to
   * the next source rather than producing a wrong number.
   * Browse codes at https://stooq.com/t/?i=536
   */
  stooqCode: string | null;
  /** ECB Data Portal SDMX key — euro-area legs only. */
  ecbKey: string | null;
  /** FRED series — the US legs, already keyless and verified in this project. */
  fredLabel: FredLabel | null;
}

export interface RateSpreadConfig {
  /** e.g. "2Y 德美利差" */
  label: string;
  tenor: "2Y" | "10Y";
  /**
   * spread = minuend − subtrahend, arranged so that a **rising** spread always
   * favours a long position in the symbol. Getting this backwards would invert
   * a whole dimension, so each entry states its reasoning.
   */
  minuend: YieldLegSource;
  subtrahend: YieldLegSource;
  /** Why a rising spread is bullish for this symbol. */
  rationale: string;
}

const US_2Y: YieldLegSource = {
  label: "美國 2Y",
  stooqCode: "2yusy.b",
  ecbKey: null,
  fredLabel: "DGS02",
};

const US_10Y: YieldLegSource = {
  label: "美國 10Y",
  stooqCode: "10yusy.b",
  ecbKey: null,
  fredLabel: "DGS10",
};

export const RATE_SPREADS: Record<string, RateSpreadConfig> = {
  EURUSD: {
    label: "2Y 德美利差",
    tenor: "2Y",
    minuend: {
      label: "德國 2Y",
      stooqCode: "2ydey.b",
      // Euro-area AAA government bond spot rate, 2Y — the ECB's own curve.
      ecbKey: "YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_2Y",
      fredLabel: null,
    },
    subtrahend: US_2Y,
    rationale: "德債殖利率相對美債走高 → 資金偏好歐元 → EURUSD 偏多",
  },
  GBPUSD: {
    label: "2Y 英美利差",
    tenor: "2Y",
    minuend: { label: "英國 2Y", stooqCode: "2yuky.b", ecbKey: null, fredLabel: null },
    subtrahend: US_2Y,
    rationale: "英債殖利率相對美債走高 → 資金偏好英鎊 → GBPUSD 偏多",
  },
  USDJPY: {
    // Long end here on purpose: the BOJ has directly controlled the JGB curve,
    // so the 10Y gap is where the policy divergence actually shows up.
    label: "10Y 美日利差",
    tenor: "10Y",
    minuend: US_10Y,
    subtrahend: { label: "日本 10Y", stooqCode: "10yjpy.b", ecbKey: null, fredLabel: null },
    rationale: "美債殖利率相對日債走高 → 套利偏好美元 → USDJPY 偏多",
  },
};

export function rateSpreadFor(symbol: string): RateSpreadConfig | null {
  return RATE_SPREADS[symbol] ?? null;
}

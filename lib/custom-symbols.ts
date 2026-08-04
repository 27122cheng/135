import type { CommodityMeta } from "@/types/signal";

/**
 * User-added analysis targets. Stored in localStorage so adding one needs no
 * database, no key and no redeploy — the definition travels to the API with
 * each request instead of being persisted server-side.
 */
export interface CustomSymbol {
  /** Identifier shown in the UI and used as TradeSignal.symbol. */
  symbol: string;
  label: string;
  /** Yahoo Finance ticker, e.g. "SI=F" (silver), "BTC-USD", "^N225". */
  yahooSymbol: string;
  /** Stooq ticker for the keyless fallback, e.g. "xagusd". Optional. */
  stooqSymbol: string;
  /** CFTC contract code for 籌碼面/未平倉量. Empty = skip those dimensions. */
  cotContractCode: string;
  /** GDELT query for 新聞面. */
  gdeltQuery: string;
}

const STORAGE_KEY = "custom-symbols-v1";

/**
 * Tickers are interpolated into upstream URLs, so they are restricted to the
 * characters real tickers actually use. This is the client-side copy of the
 * same rule the API enforces — the server never trusts this one.
 */
export const TICKER_PATTERN = /^[A-Za-z0-9=^._:/-]{1,24}$/;
export const SYMBOL_PATTERN = /^[A-Za-z0-9_-]{1,20}$/;
export const COT_PATTERN = /^[A-Za-z0-9]{1,10}$/;

export function validateCustomSymbol(s: CustomSymbol): string | null {
  if (!SYMBOL_PATTERN.test(s.symbol)) return "代號只能用英數字、底線與連字號，最長 20 字";
  if (!s.label.trim() || s.label.length > 40) return "顯示名稱不可空白，最長 40 字";
  if (!TICKER_PATTERN.test(s.yahooSymbol)) return "Yahoo 代碼格式不正確";
  if (s.stooqSymbol && !TICKER_PATTERN.test(s.stooqSymbol)) return "Stooq 代碼格式不正確";
  if (s.cotContractCode && !COT_PATTERN.test(s.cotContractCode)) return "CFTC 合約代碼格式不正確";
  if (s.gdeltQuery.length > 200) return "新聞查詢字串過長（上限 200 字）";
  return null;
}

export function loadCustomSymbols(): CustomSymbol[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is CustomSymbol => validateCustomSymbol(s) === null);
  } catch {
    return [];
  }
}

export function saveCustomSymbols(list: CustomSymbol[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

/** Shown in the same chip row as the built-ins. */
export function toCommodityMeta(s: CustomSymbol): CommodityMeta {
  return {
    symbol: s.symbol,
    label: s.label,
    category: "index",
    twelveDataSymbol: s.yahooSymbol,
    yfinanceSymbol: s.yahooSymbol,
    stooqSymbol: s.stooqSymbol || s.yahooSymbol,
    implemented: true,
  };
}

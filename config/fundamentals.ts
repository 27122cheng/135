import type { SupportedSymbol } from "@/types/signal";

export interface FundamentalsConfig {
  symbol: string;
  /** 實質利率 (DGS10-T10YIE) — spec 中僅 XAUUSD 使用此因子。 */
  useRealRate: boolean;
  /** DXY 廣義美元指數趨勢，做為全商品通用的美元強弱交叉檢查。 */
  useDxy: boolean;
  /** true 表示 DXY 走弱應解讀為看空（僅 USD/JPY：美元是報價貨幣的分母，
   * 美元轉弱時 USD/JPY 傾向下跌）；其餘商品皆為 DXY 走弱＝看多。 */
  dxyInverted: boolean;
  /** VIX 風險情緒，全商品通用。 */
  useVix: boolean;
  /** VIX 飆高（風險趨避）時，此商品應解讀為哪個方向：黃金避險買盤=long，股指風險資產拋售=short。 */
  vixRiskOffDirection: "long" | "short";
  /** 財報季訊號（Finnhub /calendar/earnings）— 美股指數專用。 */
  useEarningsSeason: boolean;
  /** EIA 原油庫存週變化 — WTI 專用。不在 Stage 1 核准清單內，Stage 2 新增（見 README）。 */
  useEiaInventory: boolean;
  /**
   * CFTC COT legacy futures-only report 合約代碼。null 代表該商品無 CFTC 資料
   * （例如 GER40/DAX 在 Eurex 交易，非美國受監管交易所，CFTC 不會有報告）。
   * 代碼取自訓練資料記憶、未於此沙盒環境即時驗證，信心度標註於註解。
   *
   * 也可以給一組候選代碼：同一個標的在 CFTC 會有期貨專用、合併、舊制等不只
   * 一個代碼，而哪一個真的有資料，文件上看不出來。所有候選會在同一個請求裡
   * 一起查，所以列三個跟列一個一樣便宜。
   */
  cotContractCode: string | string[] | null;
  /** true 表示該外匯合約報價方向與 symbol 的報價方向相反（例如 CME 日圓期貨是「每日圓兌美元」，
   * 非商業淨多單放大代表看多日圓＝看空 USD/JPY），計算 bias 時需要反轉正負號。 */
  cotInverted: boolean;
  /** 新聞面：Finnhub headline 關鍵字篩選。 */
  newsKeywords: string[];
  /** 新聞面：GDELT 2.0 DOC API 查詢字串。 */
  gdeltQuery: string;
  /** SPDR 系列 ETF 持倉，目前僅黃金 (GLD) 有已知公開來源。 */
  etfHoldings: "GLD" | null;
}

export const FUNDAMENTALS_CONFIG: Record<SupportedSymbol, FundamentalsConfig> = {
  XAUUSD: {
    symbol: "XAUUSD",
    useRealRate: true,
    useDxy: true,
    dxyInverted: false,
    useVix: true,
    vixRiskOffDirection: "long",
    useEarningsSeason: false,
    useEiaInventory: false,
    cotContractCode: "088691", // GOLD - COMMODITY EXCHANGE INC.
    cotInverted: false,
    newsKeywords: ["gold", "bullion", "precious metal", "fed", "inflation"],
    gdeltQuery: '"gold price" OR bullion OR "gold futures"',
    etfHoldings: "GLD",
  },
  NAS100: {
    symbol: "NAS100",
    useRealRate: false,
    useDxy: true,
    dxyInverted: false,
    useVix: true,
    vixRiskOffDirection: "short",
    useEarningsSeason: true,
    useEiaInventory: false,
    // 20974P (consolidated) returned 查無資料 on every run; 209742 is the
    // futures-only E-MINI NASDAQ-100 series that actually has rows. Both are
    // listed so a change at the CFTC's end doesn't silently empty this again.
    cotContractCode: ["209742", "20974P"],
    cotInverted: false,
    newsKeywords: ["nasdaq", "tech stocks", "fed", "rate cut", "rate hike"],
    gdeltQuery: '"Nasdaq 100" OR "tech stocks" OR "Nasdaq index"',
    etfHoldings: null,
  },
  GER40: {
    symbol: "GER40",
    useRealRate: false,
    useDxy: true,
    dxyInverted: false,
    useVix: true,
    vixRiskOffDirection: "short",
    useEarningsSeason: false,
    useEiaInventory: false,
    cotContractCode: null, // DAX 於 Eurex（德國）交易，非美國受監管交易所，CFTC 無資料
    cotInverted: false,
    newsKeywords: ["dax", "german stocks", "ecb", "europe economy"],
    gdeltQuery: 'DAX OR "German stocks" OR "European Central Bank"',
    etfHoldings: null,
  },
  US30: {
    symbol: "US30",
    useRealRate: false,
    useDxy: true,
    dxyInverted: false,
    useVix: true,
    vixRiskOffDirection: "short",
    useEarningsSeason: true,
    useEiaInventory: false,
    cotContractCode: "124603", // DJIA ($5) - CBOT，信心度中等
    cotInverted: false,
    newsKeywords: ["dow jones", "us stocks", "fed"],
    gdeltQuery: '"Dow Jones" OR "US stocks" OR "Federal Reserve"',
    etfHoldings: null,
  },
  SPX500: {
    symbol: "SPX500",
    useRealRate: false,
    useDxy: true,
    dxyInverted: false,
    useVix: true,
    vixRiskOffDirection: "short",
    useEarningsSeason: true,
    useEiaInventory: false,
    cotContractCode: "13874A", // E-MINI S&P 500 - CME，信心度中等
    cotInverted: false,
    newsKeywords: ["s&p 500", "us stocks", "fed"],
    gdeltQuery: '"S&P 500" OR "US stocks" OR "Federal Reserve"',
    etfHoldings: null,
  },
  WTI: {
    symbol: "WTI",
    useRealRate: false,
    useDxy: true,
    dxyInverted: false,
    useVix: false,
    vixRiskOffDirection: "short",
    useEarningsSeason: false,
    useEiaInventory: true,
    cotContractCode: "067651", // CRUDE OIL, LIGHT SWEET - NYMEX，信心度中等
    cotInverted: false,
    newsKeywords: ["crude oil", "opec", "wti", "oil inventory"],
    gdeltQuery: '"crude oil" OR OPEC OR "oil inventory"',
    etfHoldings: null,
  },
  EURUSD: {
    symbol: "EURUSD",
    useRealRate: false,
    useDxy: true,
    dxyInverted: false,
    useVix: false,
    vixRiskOffDirection: "short",
    useEarningsSeason: false,
    useEiaInventory: false,
    cotContractCode: "099741", // EURO FX - CME，信心度中等
    cotInverted: false,
    newsKeywords: ["euro", "ecb", "eurozone"],
    gdeltQuery: 'euro OR "European Central Bank" OR eurozone',
    etfHoldings: null,
  },
  USDJPY: {
    symbol: "USDJPY",
    useRealRate: false,
    useDxy: true,
    dxyInverted: true, // 美元走弱時 USD/JPY 傾向下跌（USD 為基準貨幣）
    useVix: false,
    vixRiskOffDirection: "short",
    useEarningsSeason: false,
    useEiaInventory: false,
    cotContractCode: "097741", // JAPANESE YEN - CME，信心度中等
    cotInverted: true, // CME 日圓期貨為「每日圓兌美元」，非商業淨多單=看多日圓=看空 USD/JPY
    newsKeywords: ["yen", "boj", "japan"],
    gdeltQuery: 'yen OR "Bank of Japan" OR "Japanese economy"',
    etfHoldings: null,
  },
  GBPUSD: {
    symbol: "GBPUSD",
    useRealRate: false,
    useDxy: true,
    dxyInverted: false,
    useVix: false,
    vixRiskOffDirection: "short",
    useEarningsSeason: false,
    useEiaInventory: false,
    cotContractCode: "096742", // BRITISH POUND STERLING - CME，信心度中等
    cotInverted: false,
    newsKeywords: ["pound", "boe", "uk economy"],
    gdeltQuery: '"British pound" OR "Bank of England" OR "UK economy"',
    etfHoldings: null,
  },
};

/**
 * Fundamentals for a user-added target. Only the dimensions that work for any
 * instrument are switched on — DXY and VIX are cross-asset, while real rate,
 * crude inventory and earnings season are instrument-specific and stay off
 * rather than being applied where they mean nothing.
 */
export function defaultFundamentals(
  symbol: string,
  opts: { cotContractCode: string | string[] | null; gdeltQuery: string; newsKeywords: string[] },
): FundamentalsConfig {
  return {
    symbol,
    useRealRate: false,
    useDxy: true,
    dxyInverted: false,
    useVix: true,
    vixRiskOffDirection: "short",
    useEarningsSeason: false,
    useEiaInventory: false,
    cotContractCode: opts.cotContractCode,
    cotInverted: false,
    newsKeywords: opts.newsKeywords,
    gdeltQuery: opts.gdeltQuery,
    etfHoldings: null,
  };
}

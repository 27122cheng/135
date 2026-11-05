import type { UserSettableKey } from "@/lib/api-key-names";

/**
 * 資料來源登記簿 — every upstream the site reads, by what it answers, in the
 * order the code tries them.
 *
 * The sources page and the diagnostics endpoint read this instead of each
 * keeping its own list. Three rules the order encodes:
 *
 *  1. **免費優先**: free, keyless sources come first in every family, so a
 *     deployment with no keys at all still answers every question it can.
 *  2. **沒資料就換下一個**: a rung that returns nothing (unreachable, empty,
 *     over quota) falls through to the next; the gap it reports names the
 *     rung, never the family.
 *  3. **三個免費首選**: each family names its first three free rungs. A
 *     family with fewer than three free rungs says so, rather than listing a
 *     paid one as if it were free.
 *
 * `probe` is a cheap GET the diagnostics endpoint can issue from the
 * deployment's own network — the only vantage point that tells "no key"
 * apart from "this host blocks our datacenter IP". Keyed rungs are probed
 * only when the key is present.
 */

export interface SourceEntry {
  id: string;
  label: string;
  /** No cost to use: keyless, or a free-tier key. */
  free: boolean;
  /** The key the rung needs; null when keyless. */
  keyName: UserSettableKey | null;
  /** Quota bucket name used by lib/data-sources/free-source.ts, for the last-success stamp. */
  quotaSource: string | null;
  /** Probe URL; null when the rung has no cheap GET (or needs a key in the URL). */
  probe: string | null;
  /** Browser user-agent needed, as some hosts refuse the default. */
  browserUa?: boolean;
  /** Coverage limits worth knowing before relying on it. */
  note?: string;
}

export interface SourceFamily {
  id: string;
  label: string;
  /** What this family answers, in the reader's words. */
  answers: string;
  ladder: SourceEntry[];
}

const UA = true;

export const SOURCE_FAMILIES: SourceFamily[] = [
  {
    id: "ohlcv",
    label: "K 棒（H4／D1／W1）",
    answers: "技術面、結構、回測、訂單流、量化統計",
    ladder: [
      { id: "yahoo-proxy", label: "Yahoo Finance 圖表（自架代理）", free: true, keyName: null, quotaSource: "yfinance", probe: "https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1d&range=5d", browserUa: UA },
      { id: "stooq", label: "Stooq CSV", free: true, keyName: null, quotaSource: "stooq", probe: "https://stooq.com/q/d/l/?s=xauusd&i=d", browserUa: UA, note: "只有日線與週線；H4 由日線無法補" },
      { id: "binance", label: "Binance（加密貨幣）", free: true, keyName: null, quotaSource: "binance", probe: "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=1", note: "只服務加密貨幣" },
      { id: "kraken", label: "Kraken（加密貨幣）", free: true, keyName: null, quotaSource: "kraken", probe: "https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=240", note: "只服務加密貨幣" },
      { id: "twelvedata", label: "Twelve Data（免費金鑰）", free: true, keyName: "TWELVEDATA_API_KEY", quotaSource: "twelvedata", probe: null, note: "每日 800 次；有 H4" },
      { id: "finnhub-ohlcv", label: "Finnhub（免費金鑰，僅美股）", free: true, keyName: "FINNHUB_API_KEY", quotaSource: "finnhub", probe: null, note: "外匯、商品、指數需付費方案" },
      { id: "fmp", label: "FMP（免費金鑰）", free: true, keyName: "FMP_API_KEY", quotaSource: "fmp", probe: null },
    ],
  },
  {
    id: "quote",
    label: "即時報價與對照證人",
    answers: "目前價格、休市判定、報價凍結偵測",
    ladder: [
      { id: "yahoo-quote", label: "Yahoo Finance 報價", free: true, keyName: null, quotaSource: "yfinance", probe: "https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X?interval=1m&range=1d", browserUa: UA },
      { id: "stooq-quote", label: "Stooq 報價", free: true, keyName: null, quotaSource: "stooq", probe: "https://stooq.com/q/l/?s=xauusd&f=sd2t2ohlcv&h&e=csv", browserUa: UA },
      { id: "swissquote", label: "Swissquote 現貨報價", free: true, keyName: null, quotaSource: "swissquote", probe: "https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD", note: "外匯與貴金屬" },
      { id: "tradingview", label: "TradingView 掃描器", free: true, keyName: null, quotaSource: "tradingview", probe: null },
      { id: "binance-witness", label: "Binance 24 小時對照（PAXG）", free: true, keyName: null, quotaSource: "binance-witness", probe: "https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=1m&limit=1", note: "只對照黃金與加密貨幣" },
      { id: "twelvedata-quote", label: "Twelve Data 報價（免費金鑰）", free: true, keyName: "TWELVEDATA_API_KEY", quotaSource: "twelvedata", probe: null },
      { id: "fmp-quote", label: "FMP 報價（免費金鑰）", free: true, keyName: "FMP_API_KEY", quotaSource: "fmp", probe: null },
    ],
  },
  {
    id: "macro",
    label: "總經序列（美元、利率、通膨、VIX）",
    answers: "基本面：實質利率、美元趨勢、風險情緒、兩國利差",
    ladder: [
      { id: "fred-csv", label: "FRED CSV", free: true, keyName: null, quotaSource: "fred", probe: "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10&cosd=2026-01-01", browserUa: UA },
      { id: "dbnomics", label: "DBnomics（IMF、各國央行）", free: true, keyName: null, quotaSource: "dbnomics", probe: "https://api.db.nomics.world/v22/series/IMF/IFS?limit=1" },
      { id: "stooq-yield", label: "Stooq 公債殖利率", free: true, keyName: null, quotaSource: "stooq", probe: "https://stooq.com/q/d/l/?s=10ydey.b&i=d", browserUa: UA },
      { id: "ecb", label: "ECB 殖利率曲線", free: true, keyName: null, quotaSource: "ecb", probe: "https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_2Y?format=csvdata&lastNObservations=1" },
      { id: "fred-api", label: "FRED API（免費金鑰）", free: true, keyName: "FRED_API_KEY", quotaSource: "fred", probe: null },
    ],
  },
  {
    id: "valuation",
    label: "估值（S&P 500 本益比）",
    answers: "基本面：股權風險溢酬、十年估值位階（指數）",
    ladder: [
      { id: "multpl", label: "multpl.com", free: true, keyName: null, quotaSource: "valuation", probe: "https://www.multpl.com/s-p-500-pe-ratio", browserUa: UA },
      { id: "nasdaq-data-link", label: "Nasdaq Data Link MULTPL", free: true, keyName: null, quotaSource: "valuation", probe: "https://data.nasdaq.com/api/v3/datasets/MULTPL/SP500_PE_RATIO_MONTH.json?rows=1", note: "匿名每日少量" },
      { id: "finviz", label: "Finviz SPY 本益比", free: true, keyName: null, quotaSource: "valuation", probe: "https://finviz.com/quote.ashx?t=SPY", browserUa: UA, note: "無歷史，算不出位階" },
    ],
  },
  {
    id: "positioning",
    label: "籌碼（COT、未平倉量）",
    answers: "籌碼面：非商業淨部位、未平倉量四象限",
    ladder: [
      { id: "cftc", label: "CFTC Socrata COT", free: true, keyName: null, quotaSource: "cftc", probe: "https://publicreporting.cftc.gov/resource/6dca-aqww.json?$where=cftc_contract_market_code='088691'&$limit=1", note: "週報，落後價格約三個交易日；DAX 無資料" },
    ],
  },
  {
    id: "flows",
    label: "資金流（ETF、央行購金）",
    answers: "資金流：GLD 持倉、央行購金、ETF 流向代理",
    ladder: [
      { id: "spdr-gld", label: "SPDR GLD 持倉 XML", free: true, keyName: null, quotaSource: "spdr", probe: "https://www.spdrgoldshares.com/assets/dynamic/GLD/GLD_US_ProductDetails.xml", browserUa: UA },
      { id: "dbnomics-gold", label: "DBnomics 央行黃金儲備", free: true, keyName: null, quotaSource: "dbnomics", probe: null },
      { id: "yahoo-etf", label: "Yahoo ETF 價量（流向代理）", free: true, keyName: null, quotaSource: "yfinance", probe: null },
    ],
  },
  {
    id: "energy",
    label: "原油庫存與期限結構",
    answers: "基本面（WTI）：EIA 週庫存、近月／次月價差",
    ladder: [
      { id: "fred-crude", label: "FRED WCESTUS1（EIA 鏡像）", free: true, keyName: null, quotaSource: "fred", probe: "https://fred.stlouisfed.org/graph/fredgraph.csv?id=WCESTUS1&cosd=2026-01-01", browserUa: UA },
      { id: "yahoo-term", label: "Yahoo NYMEX 分月合約", free: true, keyName: null, quotaSource: "yfinance", probe: null },
      { id: "eia", label: "EIA API（免費金鑰）", free: true, keyName: "EIA_API_KEY", quotaSource: "eia", probe: null },
    ],
  },
  {
    id: "news",
    label: "新聞",
    answers: "新聞面：標題情緒、事件風險",
    ladder: [
      { id: "gdelt", label: "GDELT 2.0 DOC", free: true, keyName: null, quotaSource: "gdelt", probe: "https://api.gdeltproject.org/api/v2/doc/doc?query=gold&mode=artlist&maxrecords=1&format=json&timespan=48h" },
      { id: "google-news", label: "Google News RSS", free: true, keyName: null, quotaSource: "google-news", probe: "https://news.google.com/rss/search?q=gold&hl=en-US&gl=US&ceid=US:en", browserUa: UA },
      { id: "finnhub-news", label: "Finnhub 新聞（免費金鑰）", free: true, keyName: "FINNHUB_API_KEY", quotaSource: "finnhub", probe: null },
    ],
  },
  {
    id: "calendar",
    label: "經濟數據與財報日曆",
    answers: "事件前保本、財報季提醒",
    ladder: [
      { id: "clock", label: "日曆推算（NFP／CPI／FOMC／財報季）", free: true, keyName: null, quotaSource: null, probe: null, note: "固定時程，無需連線" },
      { id: "finnhub-calendar", label: "Finnhub 日曆（免費金鑰；經濟日曆已改付費）", free: true, keyName: "FINNHUB_API_KEY", quotaSource: "finnhub", probe: null },
    ],
  },
  {
    id: "ai",
    label: "AI（新聞閱讀、計畫挑選、停損分類）",
    answers: "AI綜合：沒有金鑰時全部走本地規則，仍可運作",
    ladder: [
      { id: "gemini", label: "Gemini（免費金鑰）", free: true, keyName: "GEMINI_API_KEY", quotaSource: "gemini", probe: null },
      { id: "groq", label: "Groq（免費金鑰）", free: true, keyName: "GROQ_API_KEY", quotaSource: "groq", probe: null },
      { id: "openrouter", label: "OpenRouter（免費金鑰）", free: true, keyName: "OPENROUTER_API_KEY", quotaSource: "openrouter", probe: null },
      { id: "anthropic", label: "Anthropic（付費）", free: false, keyName: "ANTHROPIC_API_KEY", quotaSource: "anthropic", probe: null },
    ],
  },
];

/** Keyless free rungs first, then free-with-key, then paid — stable within each group. */
export function freeFirst(family: SourceFamily): SourceEntry[] {
  const rank = (e: SourceEntry) => (e.free && e.keyName === null ? 0 : e.free ? 1 : 2);
  return [...family.ladder].sort((a, b) => rank(a) - rank(b));
}

/** The family's three free first choices (fewer when it has fewer). */
export function firstThreeFree(family: SourceFamily): SourceEntry[] {
  return freeFirst(family).filter((e) => e.free).slice(0, 3);
}

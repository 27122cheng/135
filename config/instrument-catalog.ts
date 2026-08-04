/**
 * Curated lookup so adding a target only needs its name.
 *
 * Yahoo tickers are the high-confidence field — they're widely documented and
 * a wrong one fails loudly (no OHLCV → no-trade + data_gaps, never a made-up
 * number). Stooq tickers and CFTC contract codes are lower confidence: they
 * come from public references rather than live verification, and a wrong CFTC
 * code simply yields no COT rows, so 籌碼面/未平倉量 goes missing rather than
 * wrong. Anything not listed here still works — the search endpoint falls back
 * to Yahoo's own keyless search API.
 */
export interface CatalogEntry {
  symbol: string;
  label: string;
  /** Lowercase search terms — Chinese and English both match. */
  aliases: string[];
  yahooSymbol: string;
  stooqSymbol: string;
  /** Empty = no CFTC data for this instrument (籌碼面/未平倉量 will be absent). */
  cotContractCode: string;
  gdeltQuery: string;
}

export const INSTRUMENT_CATALOG: CatalogEntry[] = [
  // ── 貴金屬 ──────────────────────────────────────────────
  { symbol: "XAGUSD", label: "白銀", aliases: ["白銀", "銀", "silver", "xagusd", "si"],
    yahooSymbol: "SI=F", stooqSymbol: "xagusd", cotContractCode: "084691",
    gdeltQuery: '"silver price" OR "silver futures"' },
  { symbol: "XPTUSD", label: "白金", aliases: ["白金", "鉑", "platinum", "xptusd"],
    yahooSymbol: "PL=F", stooqSymbol: "", cotContractCode: "076651",
    gdeltQuery: '"platinum price"' },
  { symbol: "XPDUSD", label: "鈀金", aliases: ["鈀金", "鈀", "palladium"],
    yahooSymbol: "PA=F", stooqSymbol: "", cotContractCode: "075651",
    gdeltQuery: '"palladium price"' },
  { symbol: "COPPER", label: "銅", aliases: ["銅", "copper", "hg"],
    yahooSymbol: "HG=F", stooqSymbol: "hg.f", cotContractCode: "085692",
    gdeltQuery: '"copper price" OR "copper futures"' },

  // ── 能源 ────────────────────────────────────────────────
  { symbol: "NATGAS", label: "天然氣", aliases: ["天然氣", "natural gas", "natgas", "ng"],
    yahooSymbol: "NG=F", stooqSymbol: "ng.f", cotContractCode: "023651",
    gdeltQuery: '"natural gas price"' },
  { symbol: "BRENT", label: "布蘭特原油", aliases: ["布蘭特", "brent", "布倫特"],
    yahooSymbol: "BZ=F", stooqSymbol: "", cotContractCode: "",
    gdeltQuery: '"Brent crude" OR OPEC' },

  // ── 股指 ────────────────────────────────────────────────
  { symbol: "JP225", label: "日經225", aliases: ["日經", "日经", "nikkei", "jp225", "n225"],
    yahooSymbol: "^N225", stooqSymbol: "^nkx", cotContractCode: "",
    gdeltQuery: '"Nikkei" OR "Japanese stocks"' },
  { symbol: "HK50", label: "恆生指數", aliases: ["恆生", "恒生", "hang seng", "hk50", "hsi"],
    yahooSymbol: "^HSI", stooqSymbol: "", cotContractCode: "",
    gdeltQuery: '"Hang Seng" OR "Hong Kong stocks"' },
  { symbol: "TW50", label: "台股加權", aliases: ["台股", "台灣", "taiwan", "twii", "加權"],
    yahooSymbol: "^TWII", stooqSymbol: "", cotContractCode: "",
    gdeltQuery: '"Taiwan stocks" OR "TAIEX"' },
  { symbol: "RUSSELL", label: "羅素2000", aliases: ["羅素", "russell", "rut"],
    yahooSymbol: "^RUT", stooqSymbol: "", cotContractCode: "239742",
    gdeltQuery: '"Russell 2000" OR "small cap stocks"' },
  { symbol: "VIX", label: "VIX 波動率指數", aliases: ["vix", "波動率", "恐慌指數"],
    yahooSymbol: "^VIX", stooqSymbol: "", cotContractCode: "1170E1",
    gdeltQuery: '"VIX" OR "market volatility"' },

  // ── 外匯 ────────────────────────────────────────────────
  { symbol: "AUDUSD", label: "澳幣", aliases: ["澳幣", "澳元", "aussie", "audusd", "aud"],
    yahooSymbol: "AUDUSD=X", stooqSymbol: "audusd", cotContractCode: "232741",
    gdeltQuery: '"Australian dollar" OR RBA' },
  { symbol: "USDCAD", label: "加幣", aliases: ["加幣", "加元", "loonie", "usdcad", "cad"],
    yahooSymbol: "CAD=X", stooqSymbol: "usdcad", cotContractCode: "090741",
    gdeltQuery: '"Canadian dollar" OR "Bank of Canada"' },
  { symbol: "NZDUSD", label: "紐幣", aliases: ["紐幣", "紐元", "kiwi", "nzdusd", "nzd"],
    yahooSymbol: "NZDUSD=X", stooqSymbol: "nzdusd", cotContractCode: "112741",
    gdeltQuery: '"New Zealand dollar" OR RBNZ' },
  { symbol: "USDCHF", label: "瑞郎", aliases: ["瑞郎", "瑞士法郎", "swiss", "usdchf", "chf"],
    yahooSymbol: "CHF=X", stooqSymbol: "usdchf", cotContractCode: "092741",
    gdeltQuery: '"Swiss franc" OR SNB' },

  // ── 加密貨幣（無 CFTC 一般期貨報告）──────────────────────
  { symbol: "BTCUSD", label: "比特幣", aliases: ["比特幣", "bitcoin", "btc"],
    yahooSymbol: "BTC-USD", stooqSymbol: "", cotContractCode: "",
    gdeltQuery: '"Bitcoin price" OR cryptocurrency' },
  { symbol: "ETHUSD", label: "以太幣", aliases: ["以太", "ethereum", "eth"],
    yahooSymbol: "ETH-USD", stooqSymbol: "", cotContractCode: "",
    gdeltQuery: '"Ethereum price" OR cryptocurrency' },

  // ── 農產品 ──────────────────────────────────────────────
  { symbol: "CORN", label: "玉米", aliases: ["玉米", "corn"],
    yahooSymbol: "ZC=F", stooqSymbol: "", cotContractCode: "002602",
    gdeltQuery: '"corn price" OR "corn futures"' },
  { symbol: "SOYBEAN", label: "黃豆", aliases: ["黃豆", "大豆", "soybean", "soy"],
    yahooSymbol: "ZS=F", stooqSymbol: "", cotContractCode: "005602",
    gdeltQuery: '"soybean price"' },
  { symbol: "WHEAT", label: "小麥", aliases: ["小麥", "wheat"],
    yahooSymbol: "ZW=F", stooqSymbol: "", cotContractCode: "001602",
    gdeltQuery: '"wheat price"' },
  { symbol: "COFFEE", label: "咖啡", aliases: ["咖啡", "coffee"],
    yahooSymbol: "KC=F", stooqSymbol: "", cotContractCode: "083731",
    gdeltQuery: '"coffee price" OR "coffee futures"' },
  { symbol: "SUGAR", label: "糖", aliases: ["糖", "sugar"],
    yahooSymbol: "SB=F", stooqSymbol: "", cotContractCode: "080732",
    gdeltQuery: '"sugar price"' },
];

export function searchCatalog(query: string, limit = 6): CatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored = INSTRUMENT_CATALOG.map((entry) => {
    const hay = [entry.symbol.toLowerCase(), entry.label.toLowerCase(), ...entry.aliases];
    // Exact alias beats prefix beats substring, so "銅" doesn't rank below "銅價指數".
    let score = 0;
    if (hay.some((h) => h === q)) score = 3;
    else if (hay.some((h) => h.startsWith(q))) score = 2;
    else if (hay.some((h) => h.includes(q))) score = 1;
    return { entry, score };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.entry);
}

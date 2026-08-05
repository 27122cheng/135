import { searchCatalog } from "@/config/instrument-catalog";
import { fetchJson } from "@/lib/data-sources/http";
import { json } from "@/lib/json-response";

export const dynamic = "force-dynamic";

/**
 * Autofill source for /symbols. Curated catalog first — those entries carry
 * CFTC contract codes, which no public search API provides — then Yahoo's own
 * keyless search endpoint for anything not catalogued.
 */

export interface SymbolSuggestion {
  symbol: string;
  label: string;
  yahooSymbol: string;
  stooqSymbol: string;
  cotContractCode: string;
  gdeltQuery: string;
  /** Where it came from, so the UI can say what's prefilled and what isn't. */
  origin: "catalog" | "yahoo";
  hint: string;
}

interface YahooSearchResponse {
  quotes?: Array<{
    symbol?: string;
    shortname?: string;
    longname?: string;
    quoteType?: string;
    exchDisp?: string;
  }>;
}

/** Yahoo returns options/warrants too; only instrument types we can chart. */
const USABLE_TYPES = new Set(["EQUITY", "ETF", "INDEX", "FUTURE", "CURRENCY", "CRYPTOCURRENCY"]);

function toId(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  return cleaned.slice(0, 20) || "CUSTOM";
}

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 1) return json({ suggestions: [] });

  const suggestions: SymbolSuggestion[] = searchCatalog(q).map((e) => ({
    symbol: e.symbol,
    label: e.label,
    yahooSymbol: e.yahooSymbol,
    stooqSymbol: e.stooqSymbol,
    cotContractCode: e.cotContractCode,
    gdeltQuery: e.gdeltQuery,
    origin: "catalog" as const,
    hint: e.cotContractCode ? "含 CFTC 代碼，籌碼面與未平倉量可用" : "無 CFTC 資料，籌碼面從缺",
  }));

  const seen = new Set(suggestions.map((s) => s.yahooSymbol.toUpperCase()));

  // Yahoo's search needs no key and covers anything not in the catalog.
  const data = await fetchJson<YahooSearchResponse>(
    `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`,
    { headers: { "User-Agent": "Mozilla/5.0" } },
    6000,
  );
  for (const quote of data?.quotes ?? []) {
    const ticker = quote.symbol?.trim();
    if (!ticker || seen.has(ticker.toUpperCase())) continue;
    if (quote.quoteType && !USABLE_TYPES.has(quote.quoteType)) continue;
    if (!/^[A-Za-z0-9=^._:/-]{1,24}$/.test(ticker)) continue;
    const name = quote.shortname || quote.longname || ticker;
    seen.add(ticker.toUpperCase());
    suggestions.push({
      symbol: toId(ticker),
      label: name.slice(0, 40),
      yahooSymbol: ticker,
      stooqSymbol: "",
      cotContractCode: "",
      gdeltQuery: `"${name.slice(0, 60)}"`,
      origin: "yahoo",
      hint: `${quote.exchDisp ?? "Yahoo"} · 需自行填 CFTC 代碼才有籌碼面`,
    });
    if (suggestions.length >= 10) break;
  }

  return json({ suggestions });
}

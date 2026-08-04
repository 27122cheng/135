import { NextResponse } from "next/server";
import { buildSignalFor } from "@/lib/signal-builder";
import { defaultFundamentals } from "@/config/fundamentals";
import type { CommodityMeta } from "@/types/signal";
import { parseUserKeyHeader, withUserKeys } from "@/lib/api-keys";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Server-side copies of the validation rules — the client's version is a UX
// convenience, never a trust boundary. These tickers are interpolated into
// upstream URLs, so anything outside the character set real tickers use is
// rejected here rather than sanitised.
const SYMBOL_PATTERN = /^[A-Za-z0-9_-]{1,20}$/;
const TICKER_PATTERN = /^[A-Za-z0-9=^._:/-]{1,24}$/;
const COT_PATTERN = /^[A-Za-z0-9]{1,10}$/;

interface CustomSymbolBody {
  symbol?: unknown;
  label?: unknown;
  yahooSymbol?: unknown;
  stooqSymbol?: unknown;
  cotContractCode?: unknown;
  gdeltQuery?: unknown;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: Request) {
  let body: CustomSymbolBody;
  try {
    body = (await request.json()) as CustomSymbolBody;
  } catch {
    return NextResponse.json({ error: "請求內容不是有效的 JSON" }, { status: 400 });
  }

  const symbol = str(body.symbol);
  const label = str(body.label);
  const yahooSymbol = str(body.yahooSymbol);
  const stooqSymbol = str(body.stooqSymbol);
  const cotContractCode = str(body.cotContractCode);
  const gdeltQuery = str(body.gdeltQuery);

  if (!SYMBOL_PATTERN.test(symbol)) {
    return NextResponse.json({ error: "代號格式不正確" }, { status: 400 });
  }
  if (!label || label.length > 40) {
    return NextResponse.json({ error: "顯示名稱不正確" }, { status: 400 });
  }
  if (!TICKER_PATTERN.test(yahooSymbol)) {
    return NextResponse.json({ error: "Yahoo 代碼格式不正確" }, { status: 400 });
  }
  if (stooqSymbol && !TICKER_PATTERN.test(stooqSymbol)) {
    return NextResponse.json({ error: "Stooq 代碼格式不正確" }, { status: 400 });
  }
  if (cotContractCode && !COT_PATTERN.test(cotContractCode)) {
    return NextResponse.json({ error: "CFTC 合約代碼格式不正確" }, { status: 400 });
  }
  if (gdeltQuery.length > 200) {
    return NextResponse.json({ error: "新聞查詢字串過長" }, { status: 400 });
  }

  const meta: CommodityMeta = {
    symbol,
    label,
    category: "index",
    twelveDataSymbol: yahooSymbol,
    yfinanceSymbol: yahooSymbol,
    stooqSymbol: stooqSymbol || yahooSymbol,
    implemented: true,
  };
  const config = defaultFundamentals(symbol, {
    cotContractCode: cotContractCode || null,
    gdeltQuery: gdeltQuery || label,
    newsKeywords: [label.toLowerCase()],
  });

  const userKeys = parseUserKeyHeader(request.headers.get("x-user-keys"));
  try {
    const signal = await withUserKeys(userKeys, () => buildSignalFor(meta, config));
    return NextResponse.json(signal);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : `無法產生 ${symbol} 訊號` },
      { status: 502 },
    );
  }
}

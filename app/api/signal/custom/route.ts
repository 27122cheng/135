import { buildSignalFor } from "@/lib/signal-builder";
import { storeScan } from "@/lib/scan";
import { registerCustomSymbol } from "@/lib/server-symbols";
import { isCryptoYahooTicker } from "@/lib/custom-symbols";
import { defaultFundamentals } from "@/config/fundamentals";
import type { CommodityMeta } from "@/types/signal";
import { parseUserKeyHeader, withUserKeys } from "@/lib/api-keys";
import { storedApiKeys } from "@/lib/settings";
import { json } from "@/lib/json-response";

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
    return json({ error: "請求內容不是有效的 JSON" }, { status: 400 });
  }

  const symbol = str(body.symbol);
  const label = str(body.label);
  const yahooSymbol = str(body.yahooSymbol);
  const stooqSymbol = str(body.stooqSymbol);
  const cotContractCode = str(body.cotContractCode);
  const gdeltQuery = str(body.gdeltQuery);

  if (!SYMBOL_PATTERN.test(symbol)) {
    return json({ error: "代號格式不正確" }, { status: 400 });
  }
  if (!label || label.length > 40) {
    return json({ error: "顯示名稱不正確" }, { status: 400 });
  }
  if (!TICKER_PATTERN.test(yahooSymbol)) {
    return json({ error: "Yahoo 代碼格式不正確" }, { status: 400 });
  }
  if (stooqSymbol && !TICKER_PATTERN.test(stooqSymbol)) {
    return json({ error: "Stooq 代碼格式不正確" }, { status: 400 });
  }
  if (cotContractCode && !COT_PATTERN.test(cotContractCode)) {
    return json({ error: "CFTC 合約代碼格式不正確" }, { status: 400 });
  }
  if (gdeltQuery.length > 200) {
    return json({ error: "新聞查詢字串過長" }, { status: 400 });
  }

  const meta: CommodityMeta = {
    symbol,
    label,
    // The server-side twin of toCommodityMeta's rule: crypto gets 24/7 market
    // hours, crypto costs, and Binance as its primary data source.
    category: isCryptoYahooTicker(yahooSymbol) ? "crypto" : "index",
    yfinanceSymbol: yahooSymbol,
    stooqSymbol: stooqSymbol || yahooSymbol,
    // User-added targets are quoted as whatever the ticker is; spot is the
    // safe default because no basis note is then invented for them.
    contractBasis: "spot",
    implemented: true,
  };
  const config = defaultFundamentals(symbol, {
    cotContractCode: cotContractCode || null,
    gdeltQuery: gdeltQuery || label,
    newsKeywords: [label.toLowerCase()],
  });

  const userKeys = parseUserKeyHeader(request.headers.get("x-user-keys"));
  try {
    // 掃描即註冊 — scanning a custom symbol registers it server-side as a
    // side effect. The browser-sync path (the /symbols page uploading its
    // list) still exists, but it depends on the user visiting one page after
    // one deploy, and on the settings endpoint's auth mood; this route runs
    // every time the user actually looks at the symbol. Registration is what
    // puts it on the board, in the hourly sweep, under the monitor, and in
    // the lab. Best-effort and non-fatal: the scan is the job.
    await registerCustomSymbol({
      symbol,
      label,
      yahooSymbol,
      stooqSymbol,
      cotContractCode,
      gdeltQuery,
    }).catch(() => undefined);

    // Header first, stored second — see the note in /api/signal/[symbol].
    const merged = { ...(await storedApiKeys().catch(() => ({}))), ...userKeys };
    const signal = await withUserKeys(merged, () => buildSignalFor(meta, config));
    // Stored like every scheduled scan, so the board, the monitor and the
    // history see custom symbols too. Best-effort: a deployment without a
    // database still gets its on-demand card.
    const stored = await storeScan(signal).catch(
      (err: unknown): { storeError: string | null } => ({
        storeError: err instanceof Error ? err.message : String(err),
      }),
    );
    return json({ ...signal, store_error: stored.storeError ?? undefined });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : `無法產生 ${symbol} 訊號` },
      { status: 502 },
    );
  }
}

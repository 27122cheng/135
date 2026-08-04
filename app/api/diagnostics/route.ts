import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Deployment troubleshooting endpoint. Reports which env vars are present
 * (booleans only — never the values) and probes each upstream host from the
 * deployment's own network, which is the only way to tell "no API key" apart
 * from "this host blocks our datacenter IP".
 */

interface ProbeResult {
  source: string;
  url: string;
  ok: boolean;
  httpStatus: number | null;
  detail: string;
  ms: number;
}

async function probe(source: string, url: string, init?: RequestInit): Promise<ProbeResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const body = await res.text();
    return {
      source,
      url,
      ok: res.ok,
      httpStatus: res.status,
      detail: res.ok ? `回應 ${body.length} bytes` : body.slice(0, 200),
      ms: Date.now() - started,
    };
  } catch (err) {
    return {
      source,
      url,
      ok: false,
      httpStatus: null,
      detail: err instanceof Error ? err.message : String(err),
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET() {
  const env = {
    TWELVE_DATA_API_KEY: Boolean(process.env.TWELVE_DATA_API_KEY),
    FRED_API_KEY: Boolean(process.env.FRED_API_KEY),
    FINNHUB_API_KEY: Boolean(process.env.FINNHUB_API_KEY),
    EIA_API_KEY: Boolean(process.env.EIA_API_KEY),
    ANTHROPIC_API_KEY: Boolean(process.env.ANTHROPIC_API_KEY),
    NEXT_PUBLIC_SUPABASE_URL: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    CRON_SECRET: Boolean(process.env.CRON_SECRET),
  };

  const twelveKey = process.env.TWELVE_DATA_API_KEY;
  const fredKey = process.env.FRED_API_KEY;

  const probes = await Promise.all([
    probe(
      "yfinance 備援 (Yahoo chart)",
      "https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1d&range=5d",
      { headers: { "User-Agent": "Mozilla/5.0" } },
    ),
    probe("GDELT 2.0 (免金鑰)", "https://api.gdeltproject.org/api/v2/doc/doc?query=gold&mode=artlist&maxrecords=1&format=json&timespan=48h"),
    probe(
      "CFTC Socrata COT (免金鑰)",
      "https://publicreporting.cftc.gov/resource/6dca-aqww.json?$where=cftc_contract_market_code='088691'&$limit=1",
    ),
    probe("Stooq CSV 備援 (免金鑰)", "https://stooq.com/q/d/l/?s=xauusd&i=d", {
      headers: { "User-Agent": "Mozilla/5.0" },
    }),
    probe(
      "FRED CSV (免金鑰)",
      "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10&cosd=2026-01-01",
      { headers: { "User-Agent": "Mozilla/5.0" } },
    ),
    probe("SPDR GLD 持倉 (免金鑰)", "https://www.spdrgoldshares.com/assets/dynamic/GLD/GLD_US_ProductDetails.xml", {
      headers: { "User-Agent": "Mozilla/5.0" },
    }),
    twelveKey
      ? probe(
          "Twelve Data（選用）",
          `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=1day&outputsize=1&apikey=${twelveKey}`,
        )
      : Promise.resolve<ProbeResult>({
          source: "Twelve Data（選用）",
          url: "-",
          ok: true,
          httpStatus: null,
          detail: "未設定金鑰，改用免金鑰備援（不影響運作）",
          ms: 0,
        }),
    fredKey
      ? probe(
          "FRED JSON API（選用）",
          `https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key=${fredKey}&file_type=json&limit=1`,
        )
      : Promise.resolve<ProbeResult>({
          source: "FRED JSON API（選用）",
          url: "-",
          ok: true,
          httpStatus: null,
          detail: "未設定金鑰，改用免金鑰 CSV 端點（不影響運作）",
          ms: 0,
        }),
  ]);

  // Never echo a key back — strip it from any URL shown in the response.
  const sanitized = probes.map((p) => ({
    ...p,
    url: p.url.replace(/(apikey|api_key)=[^&]+/g, "$1=REDACTED"),
  }));

  const ohlcvReachable = sanitized.some(
    (p) => p.httpStatus !== null && p.ok && (p.source.startsWith("yfinance") || p.source.startsWith("Stooq") || p.source.startsWith("Twelve Data")),
  );

  return NextResponse.json({
    checkedAt: new Date().toISOString(),
    env,
    probes: sanitized,
    verdict: ohlcvReachable
      ? "至少一個 OHLCV 來源可用，訊號應該可以產生。"
      : "沒有任何 OHLCV 來源可用 —— 訊號一定會是 no-trade。請設定 TWELVE_DATA_API_KEY，或確認部署環境是否被 Yahoo 封鎖。",
  });
}

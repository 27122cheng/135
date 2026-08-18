import { aiProviderStatus } from "@/lib/ai";
import { quotaSnapshot } from "@/lib/data-sources/quota";
import { storeKind } from "@/lib/db";
import { notifyStatus } from "@/lib/notify";
import { configuredMinGrade } from "@/lib/notify/alert";
import { json } from "@/lib/json-response";

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
    GEMINI_API_KEY: Boolean(process.env.GEMINI_API_KEY),
    GROQ_API_KEY: Boolean(process.env.GROQ_API_KEY),
    OPENROUTER_API_KEY: Boolean(process.env.OPENROUTER_API_KEY),
    ANTHROPIC_API_KEY: Boolean(process.env.ANTHROPIC_API_KEY),
    FRED_API_KEY: Boolean(process.env.FRED_API_KEY),
    FINNHUB_API_KEY: Boolean(process.env.FINNHUB_API_KEY),
    EIA_API_KEY: Boolean(process.env.EIA_API_KEY),
    DATABASE_URL: Boolean(process.env.DATABASE_URL),
    TELEGRAM_BOT_TOKEN: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    TELEGRAM_CHAT_ID: Boolean(process.env.TELEGRAM_CHAT_ID),
    DISCORD_WEBHOOK_URL: Boolean(process.env.DISCORD_WEBHOOK_URL),
    NEXT_PUBLIC_SUPABASE_URL: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    CRON_SECRET: Boolean(process.env.CRON_SECRET),
  };

  const probes = await Promise.all([
    probe(
      "行情代理 (Yahoo chart)",
      "https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1d&range=5d",
      { headers: { "User-Agent": "Mozilla/5.0" } },
    ),
    probe(
      "Twelve Data 報價 (需金鑰)",
      "https://api.twelvedata.com/quote?symbol=EUR/USD&apikey=demo",
    ),
    probe(
      "FMP 報價 (需金鑰)",
      "https://financialmodelingprep.com/api/v3/quote/EURUSD?apikey=demo",
    ),
    probe(
      "Binance 24 小時對照 (免金鑰)",
      "https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=1m&limit=1",
    ),
    probe("Stooq CSV 備援 (免金鑰)", "https://stooq.com/q/d/l/?s=xauusd&i=d", {
      headers: { "User-Agent": "Mozilla/5.0" },
    }),
    probe(
      "GDELT 2.0 (免金鑰)",
      "https://api.gdeltproject.org/api/v2/doc/doc?query=gold&mode=artlist&maxrecords=1&format=json&timespan=48h",
    ),
    probe(
      "CFTC Socrata COT (免金鑰)",
      "https://publicreporting.cftc.gov/resource/6dca-aqww.json?$where=cftc_contract_market_code='088691'&$limit=1",
    ),
    probe(
      "FRED CSV (免金鑰)",
      "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10&cosd=2026-01-01",
      { headers: { "User-Agent": "Mozilla/5.0" } },
    ),
    probe("Stooq 殖利率 (免金鑰)", "https://stooq.com/q/d/l/?s=10ydey.b&i=d", {
      headers: { "User-Agent": "Mozilla/5.0" },
    }),
    probe(
      "ECB 殖利率曲線 (免金鑰)",
      "https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_2Y?format=csvdata&lastNObservations=1",
      { headers: { accept: "text/csv" } },
    ),
    probe(
      "SPDR GLD 持倉 (免金鑰)",
      "https://www.spdrgoldshares.com/assets/dynamic/GLD/GLD_US_ProductDetails.xml",
      { headers: { "User-Agent": "Mozilla/5.0" } },
    ),
  ]);

  // Never echo a key back — strip it from any URL shown in the response.
  const sanitized = probes.map((p) => ({
    ...p,
    url: p.url.replace(/(apikey|api_key|token|key)=[^&]+/gi, "$1=REDACTED"),
  }));

  const ohlcvReachable = sanitized.some(
    (p) => p.ok && (p.source.startsWith("行情代理") || p.source.startsWith("Stooq")),
  );
  const ai = aiProviderStatus();
  const store = storeKind();

  return json({
    checkedAt: new Date().toISOString(),
    env,
    // Which provider would answer, in order. configured=false means no key, so
    // the chain skips it silently rather than counting it as a failure.
    aiProviders: ai,
    database: store,
    // Alerts only fire from the scheduled refresh, so this reports what that
    // run would be able to do — not what the browser can reach.
    alerts: { channels: await notifyStatus(), minGrade: await configuredMinGrade() },
    // Live counters per source, so "why did it stop calling X" has an answer.
    quota: quotaSnapshot(),
    probes: sanitized,
    verdict: [
      ohlcvReachable
        ? "至少一個 OHLCV 來源可用，訊號應該可以產生。"
        : "沒有任何 OHLCV 來源可用 —— 訊號一定會是 no-trade。部署環境可能同時被 Yahoo 與 Stooq 封鎖。",
      ai.some((p) => p.configured)
        ? null
        : "未設定任何 AI 金鑰，新聞情緒與交易計畫改走本地規則備援（仍可運作，判斷品質較低）。",
      store === "none"
        ? "未設定資料庫，/history 與排程寫入無法使用（即時查詢不受影響）。"
        : null,
    ].filter(Boolean),
  });
}

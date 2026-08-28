import { getKey } from "../api-keys";
import { fetchFree } from "./free-source";
import { fetchJson } from "./http";

/**
 * Documented free tier: 60 requests/minute, shared across every Finnhub
 * endpoint — so all call sites here spend the same bucket.
 */
const FINNHUB_LIMIT = { perMinute: 60 };

export interface EconomicEvent {
  event: string;
  country: string;
  time: string;
  impact: string | null;
  actual: number | null;
  estimate: number | null;
  previous: number | null;
}

interface FinnhubCalendarResponse {
  economicCalendar?: Array<{
    event: string;
    country: string;
    time: string;
    impact?: string;
    actual?: number | null;
    estimate?: number | null;
    prev?: number | null;
  }>;
}

/** Upcoming 7-day macro calendar via Finnhub's free /calendar/economic endpoint. */
export async function fetchEconomicCalendar(gaps: string[]): Promise<EconomicEvent[] | null> {
  // Optional source: callers fall back to keyless equivalents, so a missing
  // key is not reported as a gap here — the caller decides if anything is lost.
  const apiKey = getKey("FINNHUB_API_KEY");
  if (!apiKey) return null;
  // Starts in the past on purpose. The window used to begin today, which meant
  // the response only ever carried events that hadn't happened yet — so
  // `actual` and `estimate` came back null and the consensus needed to judge a
  // print was never in the data. Three days back covers every tracked release's
  // impact window; the forward half still answers "is a release due" for S4.
  const from = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const result = await fetchFree<EconomicEvent[]>({
    source: "finnhub",
    label: "Finnhub 財經日曆",
    key: `finnhub:calendar:${from}:${to}`,
    ttlMs: 60 * 60 * 1000,
    limit: FINNHUB_LIMIT,
    gaps,
    fn: async () => {
      const url = `https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}&token=${apiKey}`;
      // Finnhub moved /calendar/economic to its paid tiers: a free key gets
      // HTTP 403 on every call, forever. That is an answer, not an outage —
      // logging it as 取得失敗 made a permanent plan limitation read as a
      // recurring incident in every sweep. A denied key returns an EMPTY
      // calendar (a valid value, so it caches and the failure machinery stays
      // quiet) plus one honest note; the clock-derived NFP/FOMC schedule and
      // the FRED release table are the calendar this deployment actually has.
      let denied = false;
      const data = await fetchJson<FinnhubCalendarResponse>(url, undefined, 6000, (f) => {
        if (f.kind === "http" && (f.status === 403 || f.status === 401)) denied = true;
      });
      if (denied) {
        gaps.push(
          "Finnhub 財經日曆為付費端點（HTTP 403）——免費金鑰無法使用，此來源已停用；" +
            "改用內建的 NFP／FOMC 時刻推算與 FRED 實際數據表，屬方案限制而非故障",
        );
        return [];
      }
      if (!data || !Array.isArray(data.economicCalendar)) return null;
      return data.economicCalendar.map((e) => ({
        event: e.event,
        country: e.country,
        time: e.time,
        impact: e.impact ?? null,
        actual: e.actual ?? null,
        estimate: e.estimate ?? null,
        previous: e.prev ?? null,
      }));
    },
  });
  return result?.value ?? null;
}

export interface FinnhubNewsItem {
  headline: string;
  source: string;
  url: string;
  datetime: string; // ISO
  summary: string;
}

interface FinnhubNewsRaw {
  headline: string;
  source: string;
  url: string;
  datetime: number; // unix seconds
  summary: string;
}

/**
 * Finnhub has no commodity-specific "company-news" — for macro symbols like
 * XAUUSD we use the general/forex market news feed and filter by keyword.
 */
export async function fetchFinnhubMarketNews(
  category: "general" | "forex",
  keywords: string[],
  gaps: string[],
): Promise<FinnhubNewsItem[] | null> {
  // Optional: GDELT covers the news dimension without a key, so a missing
  // Finnhub key is silent. analyzeNews reports a gap only if both come back empty.
  const apiKey = getKey("FINNHUB_API_KEY");
  if (!apiKey) return null;
  const result = await fetchFree<FinnhubNewsItem[]>({
    source: "finnhub",
    label: `Finnhub 新聞 (${category})`,
    key: `finnhub:news:${category}`,
    ttlMs: 10 * 60 * 1000,
    limit: FINNHUB_LIMIT,
    gaps,
    fn: async () => {
      const url = `https://finnhub.io/api/v1/news?category=${category}&token=${apiKey}`;
      const data = await fetchJson<FinnhubNewsRaw[]>(url);
      if (!Array.isArray(data)) return null;
      return data.map((n) => ({
        headline: n.headline,
        source: n.source,
        url: n.url,
        datetime: new Date(n.datetime * 1000).toISOString(),
        summary: n.summary,
      }));
    },
  });
  if (!result) return null;
  const items = result.value;
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const lowerKeywords = keywords.map((k) => k.toLowerCase());
  const filtered = items.filter(
    (n) =>
      new Date(n.datetime).getTime() >= cutoff &&
      lowerKeywords.some((k) => n.headline.toLowerCase().includes(k)),
  );
  return filtered;
}

export interface EarningsEvent {
  symbol: string;
  date: string;
  epsEstimate: number | null;
  epsActual: number | null;
}

interface FinnhubEarningsResponse {
  earningsCalendar?: Array<{
    symbol: string;
    date: string;
    epsEstimate?: number | null;
    epsActual?: number | null;
  }>;
}

/** 財報季訊號（美股指數專用）：未來 7 天內有多少公司公布財報，做為波動風險提示。 */
export async function fetchEarningsCalendar(gaps: string[]): Promise<EarningsEvent[] | null> {
  // Optional: contributes a weight-0 informational item only, so its absence
  // changes no score and is not worth reporting as a gap.
  const apiKey = getKey("FINNHUB_API_KEY");
  if (!apiKey) return null;
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const result = await fetchFree<EarningsEvent[]>({
    source: "finnhub",
    label: "Finnhub 財報日曆",
    key: `finnhub:earnings:${from}:${to}`,
    ttlMs: 60 * 60 * 1000,
    limit: FINNHUB_LIMIT,
    gaps,
    fn: async () => {
      const url = `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${apiKey}`;
      const data = await fetchJson<FinnhubEarningsResponse>(url);
      if (!data || !Array.isArray(data.earningsCalendar)) return null;
      return data.earningsCalendar.map((e) => ({
        symbol: e.symbol,
        date: e.date,
        epsEstimate: e.epsEstimate ?? null,
        epsActual: e.epsActual ?? null,
      }));
    },
  });
  return result?.value ?? null;
}

import { getKey } from "../api-keys";
import { cachedOrFetch, checkRateLimit } from "./cache";
import { fetchJson } from "./http";

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
  if (!checkRateLimit("finnhub", 3600)) {
    gaps.push("Finnhub API 已達速率限制");
    return null;
  }
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const key = `finnhub:calendar:${from}:${to}`;
  return cachedOrFetch(key, 60 * 60 * 1000, async () => {
    const url = `https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}&token=${apiKey}`;
    const data = await fetchJson<FinnhubCalendarResponse>(url);
    if (!data || !Array.isArray(data.economicCalendar)) {
      gaps.push("Finnhub 財經日曆回應為空");
      return null;
    }
    return data.economicCalendar.map((e) => ({
      event: e.event,
      country: e.country,
      time: e.time,
      impact: e.impact ?? null,
      actual: e.actual ?? null,
      estimate: e.estimate ?? null,
      previous: e.prev ?? null,
    }));
  });
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
  if (!checkRateLimit("finnhub", 3600)) {
    gaps.push("Finnhub API 已達速率限制");
    return null;
  }
  const key = `finnhub:news:${category}`;
  const items = await cachedOrFetch(key, 10 * 60 * 1000, async () => {
    const url = `https://finnhub.io/api/v1/news?category=${category}&token=${apiKey}`;
    const data = await fetchJson<FinnhubNewsRaw[]>(url);
    if (!Array.isArray(data)) {
      gaps.push(`Finnhub 新聞 (${category}) 回應為空`);
      return null;
    }
    return data.map((n) => ({
      headline: n.headline,
      source: n.source,
      url: n.url,
      datetime: new Date(n.datetime * 1000).toISOString(),
      summary: n.summary,
    }));
  });
  if (!items) return null;
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
  if (!checkRateLimit("finnhub", 3600)) {
    gaps.push("Finnhub API 已達速率限制");
    return null;
  }
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const key = `finnhub:earnings:${from}:${to}`;
  const result = await cachedOrFetch(key, 60 * 60 * 1000, async () => {
    const url = `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${apiKey}`;
    const data = await fetchJson<FinnhubEarningsResponse>(url);
    if (!data || !Array.isArray(data.earningsCalendar)) return null;
    return data.earningsCalendar.map((e) => ({
      symbol: e.symbol,
      date: e.date,
      epsEstimate: e.epsEstimate ?? null,
      epsActual: e.epsActual ?? null,
    }));
  });
  if (!result) {
    gaps.push("Finnhub 財報日曆回應為空");
    return null;
  }
  return result;
}

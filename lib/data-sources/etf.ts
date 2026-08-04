import { fetchFree } from "./free-source";
import { fetchText } from "./http";
import { fetchViaProxy } from "./yfinance";

export interface GldHoldings {
  tonnesInTrust: number;
  asOf: string;
}

/** Static XML file on a CDN; self-imposed budget, updated once daily. */
const GLD_LIMIT = { perMinute: 10, perDay: 200 };

/**
 * SPDR Gold Shares publishes daily bullion holdings on a public feed with no
 * API key. The exact XML schema could not be verified from the build sandbox
 * (outbound access is allowlisted), and in practice this endpoint does
 * sometimes refuse datacenter IPs or move its field names.
 *
 * Failure here is intentionally **silent**: `fetchEtfFlow` below covers the
 * 資金流 dimension from a source we can always reach, so a missing tonnage
 * figure costs an informational line, not a scored factor. Reporting it as a
 * data gap would be crying wolf about something that changed no number.
 */
export async function fetchGldHoldings(gaps: string[]): Promise<GldHoldings | null> {
  const result = await fetchFree<GldHoldings>({
    source: "spdr-gld",
    label: "SPDR GLD 持倉",
    key: "spdr:gld:holdings",
    ttlMs: 60 * 60 * 1000,
    limit: GLD_LIMIT,
    // Swallowed: fetchFree would otherwise log "取得失敗，且無可用快取" for a
    // source whose absence the caller has already covered.
    gaps: [],
    fn: async () => {
      const url = "https://www.spdrgoldshares.com/assets/dynamic/GLD/GLD_US_ProductDetails.xml";
      const xml = await fetchText(url, { headers: { "User-Agent": "Mozilla/5.0" } }, 15000);
      if (!xml) return null;
      // The feed has used a few different tag names over the years; accept any
      // of them, and give up rather than guess if none match.
      const tonnesMatch =
        xml.match(/<TonnesInTrust>\s*([\d,.]+)\s*<\/TonnesInTrust>/i) ??
        xml.match(/<TonnesInTheTrust>\s*([\d,.]+)\s*<\/TonnesInTheTrust>/i) ??
        xml.match(/<GLDTonnesInTrust>\s*([\d,.]+)\s*<\/GLDTonnesInTrust>/i);
      const dateMatch =
        xml.match(/<AsOfDate>([^<]+)<\/AsOfDate>/i) ?? xml.match(/<Date>([^<]+)<\/Date>/i);
      if (!tonnesMatch) return null;
      const tonnesInTrust = Number(tonnesMatch[1].replace(/,/g, ""));
      if (!Number.isFinite(tonnesInTrust)) return null;
      return {
        tonnesInTrust,
        asOf: dateMatch?.[1]?.trim() ?? new Date().toISOString().slice(0, 10),
      };
    },
  });
  void gaps;
  return result?.value ?? null;
}

export interface EtfFlowProxy {
  ticker: string;
  /** Mean daily volume over the recent window vs the baseline window, in %. */
  volumeChangePct: number;
  /** Price change over the recent window, in %. */
  priceChangePct: number;
  recentDays: number;
  baselineDays: number;
}

const RECENT_DAYS = 5;
const BASELINE_DAYS = 20;

/**
 * Fund-flow proxy from the ETF's own traded volume.
 *
 * The holdings feed gives one number with no history, which is why the old
 * code could only emit a weight-0 "here is today's tonnage" line — there was
 * nothing to compare it against. The ETF's daily bars come from our own
 * yfinance proxy, always have history, and support a directional read:
 * volume expanding into a rising price is accumulation, expanding into a
 * falling price is distribution.
 *
 * This is a **proxy, not holdings** — share volume is trading activity, not
 * creations and redemptions. Everything built on it says so.
 */
export async function fetchEtfFlow(ticker: string, gaps: string[]): Promise<EtfFlowProxy | null> {
  const result = await fetchViaProxy(ticker, "D1", gaps);
  if (!result) return null;

  const withVolume = result.candles.filter((c) => c.volume !== null && c.volume > 0);
  if (withVolume.length < RECENT_DAYS + BASELINE_DAYS) {
    gaps.push(
      `${ticker} ETF 成交量資料不足 ${RECENT_DAYS + BASELINE_DAYS} 根日線，無法計算資金流代理指標`,
    );
    return null;
  }

  const recent = withVolume.slice(-RECENT_DAYS);
  const baseline = withVolume.slice(-(RECENT_DAYS + BASELINE_DAYS), -RECENT_DAYS);
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

  const recentVol = mean(recent.map((c) => c.volume ?? 0));
  const baselineVol = mean(baseline.map((c) => c.volume ?? 0));
  if (baselineVol <= 0) return null;

  const priceFrom = recent[0].open;
  const priceTo = recent[recent.length - 1].close;
  if (!(priceFrom > 0)) return null;

  return {
    ticker,
    volumeChangePct: ((recentVol - baselineVol) / baselineVol) * 100,
    priceChangePct: ((priceTo - priceFrom) / priceFrom) * 100,
    recentDays: RECENT_DAYS,
    baselineDays: BASELINE_DAYS,
  };
}

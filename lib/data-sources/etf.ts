import { cachedOrFetch } from "./cache";
import { fetchText } from "./http";

export interface GldHoldings {
  tonnesInTrust: number;
  asOf: string;
}

/**
 * SPDR Gold Shares (GLD) publishes daily bullion holdings on a public feed
 * with no API key. This sandbox's network policy blocks spdrgoldshares.com
 * (only a small allowlist of hosts is reachable here), so the exact XML
 * schema below could not be live-verified during this build — it's coded
 * defensively against the documented field names and fails safe to
 * `data_gaps` on any parse mismatch rather than fabricating a value.
 * Verify against a live response once deployed with outbound access.
 */
export async function fetchGldHoldings(gaps: string[]): Promise<GldHoldings | null> {
  const key = "spdr:gld:holdings";
  const result = await cachedOrFetch(key, 60 * 60 * 1000, async () => {
    const url = "https://www.spdrgoldshares.com/assets/dynamic/GLD/GLD_US_ProductDetails.xml";
    const xml = await fetchText(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!xml) return null;
    const tonnesMatch = xml.match(/<TonnesInTrust>([\d.]+)<\/TonnesInTrust>/i);
    const dateMatch = xml.match(/<AsOfDate>([^<]+)<\/AsOfDate>/i);
    if (!tonnesMatch) return null;
    const tonnesInTrust = Number(tonnesMatch[1]);
    if (!Number.isFinite(tonnesInTrust)) return null;
    return { tonnesInTrust, asOf: dateMatch?.[1] ?? new Date().toISOString().slice(0, 10) };
  });
  if (!result) {
    gaps.push("SPDR GLD 持倉資料取得失敗或格式解析失敗（此環境無法連線驗證來源格式）");
    return null;
  }
  return result;
}

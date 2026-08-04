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
    const xml = await fetchText(url, { headers: { "User-Agent": "Mozilla/5.0" } }, 15000);
    if (!xml) return null;
    // The feed has used a few different tag names over the years; accept any of
    // them, and bail to data_gaps rather than guessing if none match.
    const tonnesMatch =
      xml.match(/<TonnesInTrust>\s*([\d,.]+)\s*<\/TonnesInTrust>/i) ??
      xml.match(/<TonnesInTheTrust>\s*([\d,.]+)\s*<\/TonnesInTheTrust>/i) ??
      xml.match(/<GLDTonnesInTrust>\s*([\d,.]+)\s*<\/GLDTonnesInTrust>/i);
    const dateMatch =
      xml.match(/<AsOfDate>([^<]+)<\/AsOfDate>/i) ?? xml.match(/<Date>([^<]+)<\/Date>/i);
    if (!tonnesMatch) return null;
    const tonnesInTrust = Number(tonnesMatch[1].replace(/,/g, ""));
    if (!Number.isFinite(tonnesInTrust)) return null;
    return { tonnesInTrust, asOf: dateMatch?.[1]?.trim() ?? new Date().toISOString().slice(0, 10) };
  });
  if (!result) {
    gaps.push("SPDR GLD 持倉資料取得失敗或 XML 格式與預期不符（來源未經即時驗證，見 README）");
    return null;
  }
  return result;
}

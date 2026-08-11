import { fetchText } from "./http";

/**
 * One door to Stooq, with a spare key.
 *
 * The live deployment logged "Stooq 報價 (^ndx) stooq 目前連線不穩（已連續失敗
 * 5 次）" — not a refusal but a connection-level failure, with the User-Agent
 * already set. Stooq serves the identical CSV endpoints from stooq.pl (it is a
 * Polish service; .com is the mirror), so when the .com host is unreachable
 * from a datacenter egress the .pl host is a second route to the same data,
 * not a second source. Every Stooq caller goes through here so none of them
 * re-learns this individually.
 */
const STOOQ_HOSTS = ["https://stooq.com", "https://stooq.pl"];

/**
 * Fetches `pathAndQuery` (e.g. "/q/l/?s=xauusd&…") from stooq.com, then
 * stooq.pl on failure. Returns the first non-HTML body, or null.
 */
export async function fetchStooqText(
  pathAndQuery: string,
  timeoutMs = 8000,
): Promise<string | null> {
  for (const host of STOOQ_HOSTS) {
    const text = await fetchText(
      `${host}${pathAndQuery}`,
      { headers: { "User-Agent": "Mozilla/5.0" } },
      timeoutMs,
    );
    // An HTML body is an error page wearing a 200.
    if (text && !text.trim().startsWith("<")) return text;
  }
  return null;
}

import type { CommodityMeta, SupportedSymbol } from "@/types/signal";
import { fetchFree } from "./free-source";
import { fetchJson } from "./http";
import type { LatestPrice } from "./yfinance";

/**
 * Swissquote 公開報價 — an independent, keyless, spot-basis quote witness.
 *
 * ## Why another one
 *
 * Gold's live quote sources all went dark at once. One production sweep
 * recorded, on XAUUSD alone:
 *
 *   即時報價 (XAUUSD=X) 取得失敗，且無可用快取
 *   FMP 即時報價 (XAUUSD) 取得失敗，且無可用快取
 *   TradingView (OANDA:XAUUSD) 未回傳有效價格
 *   Stooq 報價 (xauusd) 取得失敗，且無可用快取
 *   → 即時報價來源已 14.5 小時未更新
 *
 * Four legs, zero answers, and the whole chain fell through to a daily backup
 * — on the instrument the operator watches most. A 14.5-hour-old "quote" is
 * not a quote: past the monitor's own 3-hour liveness bound it declines to
 * judge entries or exits at all, so gold stops being tracked entirely.
 *
 * The four that failed are not as independent as their names suggest — the
 * Yahoo proxy and Stooq both serve `XAUUSD=X`-shaped synthetic FX tickers
 * that are thin intraday, TradingView's is an unofficial surface, and FMP's
 * free tier no longer covers commodities. Swissquote is a different kind of
 * source: a regulated broker publishing its own dealable BBO, which is the
 * price a person could actually trade on.
 *
 * ## Spot only, deliberately
 *
 * This feed quotes spot, so it is mapped only to instruments that declare
 * `contractBasis: "spot"` — the three FX majors and gold. The index and
 * energy symbols declare futures, and serving them a spot price is precisely
 * the bug this codebase already paid for once: gold was mapped to COMEX
 * `GC=F`, quoted 1.28% above spot, and the site showed 4,448 against a
 * broker's 4,391 — above that day's actual spot high. A basis mismatch is
 * not a rounding difference, it is a different instrument.
 *
 * ## Reading the response
 *
 * The endpoint answers with one entry per trading platform, each carrying
 * several spread profiles (retail through institutional). The tightest
 * profile's mid is the closest thing to the underlying, so that is what is
 * taken. Every field is validated: an unstamped price would win every
 * freshness contest by construction, and an absurd spread means the feed is
 * quoting something other than a live market. Anything unexpected is a
 * reported failure, never a guessed price.
 */

/**
 * Our symbol → Swissquote's BASE/QUOTE path. Spot-basis instruments only;
 * see the basis note above for why this map must never grow an index.
 */
const SQ_PAIR: Partial<Record<SupportedSymbol, string>> = {
  EURUSD: "EUR/USD",
  USDJPY: "USD/JPY",
  GBPUSD: "GBP/USD",
  XAUUSD: "XAU/USD",
};

export function swissquotePair(symbol: string): string | null {
  return SQ_PAIR[symbol as SupportedSymbol] ?? null;
}

interface SpreadProfilePrice {
  spreadProfile?: string;
  bid?: number;
  ask?: number;
}

interface PlatformQuote {
  ts?: number;
  spreadProfilePrices?: SpreadProfilePrice[];
}

/**
 * A quote wider than this is not a live two-way market — it is a feed with
 * the book pulled, a stale snapshot, or a symbol this venue does not really
 * make. Half a percent is already generous for a major or for gold.
 */
const MAX_SPREAD_FRACTION = 0.005;

/** The tightest valid mid across every platform and profile, with its stamp. */
export function pickSwissquoteQuote(
  body: unknown,
): { price: number; at: string; spreadPct: number } | null {
  if (!Array.isArray(body)) return null;
  let best: { price: number; at: string; spreadPct: number } | null = null;

  for (const entry of body as PlatformQuote[]) {
    if (!entry || typeof entry !== "object") continue;
    const ts = entry.ts;
    // No timestamp, no quote — the same rule every other leg in this chain
    // applies. An unstamped price would be treated as freshest by definition.
    if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) continue;
    const at = new Date(ts);
    if (Number.isNaN(at.getTime())) continue;
    // Epoch seconds mistaken for milliseconds would date the quote to 1970
    // and be silently discarded by the staleness gate; refuse it explicitly.
    if (at.getUTCFullYear() < 2000) continue;

    const profiles = entry.spreadProfilePrices;
    if (!Array.isArray(profiles)) continue;
    for (const p of profiles) {
      const { bid, ask } = p ?? {};
      if (typeof bid !== "number" || typeof ask !== "number") continue;
      if (!Number.isFinite(bid) || !Number.isFinite(ask)) continue;
      if (bid <= 0 || ask <= 0 || ask < bid) continue;
      const mid = (bid + ask) / 2;
      const spreadPct = (ask - bid) / mid;
      if (spreadPct > MAX_SPREAD_FRACTION) continue;
      if (!best || spreadPct < best.spreadPct) {
        best = { price: mid, at: at.toISOString(), spreadPct };
      }
    }
  }
  return best;
}

export async function fetchSwissquoteQuote(
  meta: Pick<CommodityMeta, "symbol">,
  gaps: string[],
): Promise<LatestPrice | null> {
  const pair = swissquotePair(meta.symbol);
  if (!pair) return null;

  const result = await fetchFree<{ price: number; at: string }>({
    source: "swissquote",
    label: `Swissquote 報價 (${pair})`,
    key: `swissquote:quote:${pair}`,
    ttlMs: 2 * 60 * 1000,
    // A stale quote is worse than none for position management — the same
    // bound every live leg here uses.
    staleMs: 10 * 60 * 1000,
    // Self-imposed. The endpoint publishes no limit and is a courtesy feed;
    // a courtesy deserves gentler treatment than a documented allowance.
    limit: { perMinute: 20 },
    gaps,
    fn: async () => {
      const body = await fetchJson<unknown>(
        `https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/${pair}`,
        undefined,
        7000,
      );
      const picked = pickSwissquoteQuote(body);
      if (!picked) return null;
      return { price: Number(picked.price.toFixed(5)), at: picked.at };
    },
  });

  if (!result) return null;
  return {
    price: result.value.price,
    at: result.value.at,
    ageMinutes: Math.max(0, (Date.now() - new Date(result.value.at).getTime()) / 60000),
    source: "swissquote",
  };
}

import type { SupportedSymbol } from "@/types/signal";
import { fetchFree } from "./free-source";
import { fetchJson } from "./http";

/**
 * 24 小時市場的對照證人 — keyless, and deliberately **not** a price source.
 *
 * ## What it is for
 *
 * Binance lists tokenised or stablecoin-quoted versions of three of these
 * instruments and trades them every second of every day, with no key and no
 * quota. That makes it useless as a price and valuable as a witness, because
 * it can answer two questions nothing else here can:
 *
 * 1. **Is the market actually shut, or are our feeds dark?** When both the
 *    quote and the candles have gone quiet, the system says 休市中 — and it
 *    has been wrong about that for a day and a half at a time. If the 24-hour
 *    proxy printed a minute ago, the market is trading and the silence is
 *    ours.
 * 2. **Is the price we are using still the market's price?** A feed that
 *    freezes usually keeps answering, with yesterday's number. A live
 *    independent instrument that has moved 2% away from our quote is evidence
 *    the quote is stale — the failure mode a staleness *timestamp* cannot
 *    catch, because a frozen feed reports a fresh timestamp.
 *
 * ## Why it must never set the price
 *
 * PAXG is gold held in a vault and trades at a premium or discount to spot;
 * USDT is a dollar claim, not a dollar. The basis is small — usually well
 * under 1% — and it is *not zero*, so putting these numbers into an entry
 * zone would mean building levels on the wrong instrument to save a lookup.
 * They are compared against, and reported on, and that is all.
 */

/**
 * The 24/7 instrument that tracks each symbol, and how far apart they may sit.
 * `krakenPair` is the same comparison on a venue that serves the US region
 * this deployment runs in (Binance answers 451 there) — Kraken carries real
 * fiat EUR/USD and GBP/USD books, an even cleaner basis than the USDT peg.
 * Gold has no Kraken-listed proxy, so its witness honestly stays dark when
 * Binance is unreachable.
 */
const PROXY: Partial<
  Record<SupportedSymbol, { pair: string; krakenPair: string | null; label: string; tolerancePct: number }>
> = {
  // Stablecoin-quoted FX: the basis is the USDT peg, historically ±0.1%.
  EURUSD: { pair: "EURUSDT", krakenPair: "EURUSD", label: "EUR/USDT", tolerancePct: 1 },
  GBPUSD: { pair: "GBPUSDT", krakenPair: "GBPUSD", label: "GBP/USDT", tolerancePct: 1 },
  // Tokenised gold: a real premium/discount to spot, plus the peg.
  XAUUSD: { pair: "PAXGUSDT", krakenPair: null, label: "PAXG/USDT（代幣化黃金）", tolerancePct: 2 },
};

export function hasWitness(symbol: string): boolean {
  return PROXY[symbol as SupportedSymbol] !== undefined;
}

export interface WitnessReading {
  /** The proxy instrument's last price — for comparison only, never for levels. */
  price: number;
  /** When its most recent minute bar opened. */
  at: string;
  ageMinutes: number;
  label: string;
  tolerancePct: number;
}

/**
 * The proxy's most recent one-minute bar. Null when the symbol has no proxy,
 * or the exchange does not list the pair, or anything at all goes wrong —
 * this is a diagnostic, and a diagnostic that can break the analysis is worse
 * than no diagnostic.
 */
export async function fetchWitness(
  symbol: string,
  gaps: string[],
): Promise<WitnessReading | null> {
  const proxy = PROXY[symbol as SupportedSymbol];
  if (!proxy) return null;

  const result = await fetchFree<{ price: number; at: string }>({
    source: "binance",
    label: `24 小時對照 (${proxy.label})`,
    key: `binance:kline:${proxy.pair}`,
    // One minute: the whole point is to know whether something printed *now*.
    ttlMs: 60 * 1000,
    staleMs: 5 * 60 * 1000,
    limit: { perMinute: 30, perDay: 5000 },
    gaps,
    fn: async () => {
      const rows = await fetchJson<unknown[][]>(
        `https://api.binance.com/api/v3/klines?symbol=${proxy.pair}&interval=1m&limit=1`,
        undefined,
        5000,
      );
      const row = Array.isArray(rows) ? rows[0] : null;
      if (Array.isArray(row)) {
        const openTime = Number(row[0]);
        const close = Number(row[4]);
        if (Number.isFinite(openTime) && Number.isFinite(close) && close > 0) {
          return { price: close, at: new Date(openTime).toISOString() };
        }
      }
      // Binance unreachable (the US-region 451) — the same comparison from
      // Kraken's fiat book, with the trade's own print time.
      if (!proxy.krakenPair) return null;
      const k = await fetchJson<{
        error?: string[];
        result?: Record<string, unknown>;
      }>(
        `https://api.kraken.com/0/public/Trades?pair=${proxy.krakenPair}&count=1`,
        undefined,
        6000,
      );
      if (!k || (Array.isArray(k.error) && k.error.length > 0) || !k.result) return null;
      for (const [key, v] of Object.entries(k.result)) {
        if (key === "last" || !Array.isArray(v) || v.length === 0) continue;
        const trade = v[v.length - 1] as unknown[];
        const price = Number(trade[0]);
        const time = Number(trade[2]);
        if (Number.isFinite(price) && price > 0 && Number.isFinite(time)) {
          return { price, at: new Date(time * 1000).toISOString() };
        }
      }
      return null;
    },
  });

  if (!result) return null;
  return {
    price: result.value.price,
    at: result.value.at,
    ageMinutes: Math.max(0, (Date.now() - new Date(result.value.at).getTime()) / 60000),
    label: proxy.label,
    tolerancePct: proxy.tolerancePct,
  };
}

/** How recently the proxy must have printed to count as "the market is trading". */
const LIVE_WITHIN_MINUTES = 15;

/**
 * Rewrites a 休市中 verdict that the witness contradicts.
 *
 * The verdict itself is unchanged — `closed` stays true, because without a
 * trustworthy price there is still nothing to trade on and nothing to
 * announce. What changes is the sentence, and the difference matters: "the
 * market is shut" sends the reader away, "our feeds are down on a market that
 * is trading" sends them to /api/diagnostics. Those are opposite actions, and
 * the system has spent whole days recommending the wrong one.
 */
export function refineClosedReason(
  reason: string,
  witness: WitnessReading | null,
): { reason: string; feedDark: boolean } {
  if (!witness || witness.ageMinutes > LIVE_WITHIN_MINUTES) {
    return { reason, feedDark: false };
  }
  return {
    feedDark: true,
    reason:
      `所有價格來源停更，但這不是休市：${witness.label} 在 ${Math.round(witness.ageMinutes)} 分鐘前仍有成交，` +
      `代表對應的市場正在交易，是我們的報價來源掛了。不發送進場通知（沒有可信價格就沒有可執行的計畫），` +
      `請看 /api/diagnostics 確認各來源狀態。`,
  };
}

/**
 * Whether our price has drifted away from a market that never stops.
 *
 * A frozen feed is the hard case: it keeps answering, with a fresh-looking
 * timestamp, carrying a price from hours ago. No staleness check catches that
 * — but an independent instrument that has since moved does. Returns the
 * warning line, or null when the two agree inside the instrument's basis.
 */
export function driftWarning(
  price: number,
  witness: WitnessReading | null,
): string | null {
  if (!witness || !(price > 0) || witness.ageMinutes > LIVE_WITHIN_MINUTES) return null;
  const driftPct = Math.abs(price - witness.price) / witness.price * 100;
  if (driftPct <= witness.tolerancePct) return null;
  return (
    `報價與 ${witness.label} 相差 ${driftPct.toFixed(1)}%（我們 ${price}，對照 ${witness.price}），` +
    `超過該商品正常的價差 ${witness.tolerancePct}%。對照商品是 24 小時交易且剛剛才成交，` +
    `所以較可能是我們的報價來源停在舊價位，請以此為準重新確認再下單。`
  );
}

import { fetchFree } from "./free-source";
import { fetchYahooChart, YAHOO_LIMIT } from "./yfinance";

/**
 * WTI 期限結構 — the shape of the futures curve, which is the physical
 * market's own opinion about supply.
 *
 * Two nearby delivery months, compared:
 *
 *  - **Backwardation** (front > deferred): buyers are paying a premium for
 *    barrels *now*. Physical tightness — inventories drawing, refiners
 *    bidding for prompt supply. Historically the bullish regime.
 *  - **Contango** (front < deferred): prompt barrels are unwanted and the
 *    curve is paying you to store them. Oversupply, the bearish regime.
 *
 * This is the one外部 dataset worth adding to a system whose whole edge is
 * "few factors, each with a causal chain": the link from curve shape to
 * physical balance is direct, it is not a restatement of anything already
 * scored (price momentum, inventories and positioning all measure different
 * things), and it needs no new key — the contracts come through the same
 * Yahoo endpoint the candles do.
 *
 * ## Why a ladder rather than CL=F vs a hard-coded next month
 *
 * `CL=F` is a *continuous* front-month series; the specific contract behind
 * it rolls a few days before the 25th of the preceding month, and getting
 * that boundary wrong would silently compare a contract against itself. So
 * this asks for several dated contracts in delivery order and keeps the two
 * nearest that answer with a recent bar. Around a roll the expired leg stops
 * updating and drops out on freshness, which is exactly the desired
 * behaviour and needs no calendar of expiry rules.
 */

/** CME month codes, index 0 = January. */
const MONTH_CODES = "FGHJKMNQUVXZ";

/** e.g. (2026, 8) → "CLU26.NYM" — September 2026 WTI. */
export function contractSymbol(year: number, monthIndex: number): string {
  const y = year + Math.floor(monthIndex / 12);
  const m = ((monthIndex % 12) + 12) % 12;
  return `CL${MONTH_CODES[m]}${String(y % 100).padStart(2, "0")}.NYM`;
}

/**
 * Delivery months to try, nearest first: this month through +3. The current
 * month is included because it is still the front contract until its
 * expiry mid-month, and dropped automatically when it stops printing.
 */
export function candidateContracts(now: Date): string[] {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return [0, 1, 2, 3].map((offset) => contractSymbol(year, month + offset));
}

export interface TermStructure {
  /** Nearest delivery contract that is still trading. */
  frontSymbol: string;
  frontPrice: number;
  /** The next delivery month out. */
  nextSymbol: string;
  nextPrice: number;
  /** front − next. Positive = backwardation, negative = contango. */
  spread: number;
  /** The same as a share of the front price — comparable across price levels. */
  spreadPct: number;
  shape: "backwardation" | "contango" | "flat";
  /** Newest bar behind the front leg, so staleness is visible. */
  asOf: string;
}

/** A contract counts as live only if it printed within this window. */
const LIVE_BAR_MAX_AGE_MS = 5 * 24 * 3600_000;
/**
 * Below this the curve is flat and says nothing. WTI's month spread sits
 * within a few tenths of a percent in a balanced market; 0.3% is where the
 * shape starts being a statement rather than a bid-ask artefact.
 */
const FLAT_PCT = 0.3;

async function lastClose(
  symbol: string,
): Promise<{ price: number; at: string } | null> {
  // Daily bars over a fortnight: enough that a holiday cannot empty the
  // series, small enough to stay a cheap call.
  const res = await fetchYahooChart(
    `${encodeURIComponent(symbol)}?interval=1d&range=1mo`,
    24 * 3600_000,
  );
  const closes = res?.indicators?.quote?.[0]?.close ?? [];
  const stamps = res?.timestamp ?? [];
  for (let i = closes.length - 1; i >= 0; i--) {
    const close = closes[i];
    const ts = stamps[i];
    if (close == null || !Number.isFinite(close) || ts == null) continue;
    const at = ts * 1000;
    if (Date.now() - at > LIVE_BAR_MAX_AGE_MS) return null;
    return { price: close, at: new Date(at).toISOString() };
  }
  return null;
}

export async function fetchWtiTermStructure(
  gaps: string[],
  now = new Date(),
): Promise<TermStructure | null> {
  const result = await fetchFree<TermStructure>({
    source: "yahoo",
    label: "WTI 期限結構（近月 vs 次月）",
    key: "yahoo:wti-term-structure",
    // The curve moves on the day's news, not on the minute's — and each miss
    // costs two upstream calls, so it is worth caching properly.
    ttlMs: 30 * 60 * 1000,
    limit: YAHOO_LIMIT,
    gaps,
    fn: async () => {
      const legs: Array<{ symbol: string; price: number; at: string }> = [];
      for (const symbol of candidateContracts(now)) {
        const quote = await lastClose(symbol);
        if (quote) legs.push({ symbol, ...quote });
        // Two live legs in delivery order is the whole measurement.
        if (legs.length === 2) break;
      }
      if (legs.length < 2) return null;

      const [front, next] = legs;
      const spread = front.price - next.price;
      const spreadPct = (spread / front.price) * 100;
      return {
        frontSymbol: front.symbol,
        frontPrice: front.price,
        nextSymbol: next.symbol,
        nextPrice: next.price,
        spread: Math.round(spread * 1000) / 1000,
        spreadPct: Math.round(spreadPct * 1000) / 1000,
        shape:
          spreadPct >= FLAT_PCT
            ? "backwardation"
            : spreadPct <= -FLAT_PCT
              ? "contango"
              : "flat",
        asOf: front.at,
      };
    },
  });
  return result?.value ?? null;
}

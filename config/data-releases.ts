/**
 * 即時數據公布 — the macro prints that move a market the moment they land.
 *
 * The economic calendar was already being fetched, and `actual` / `estimate` /
 * `previous` were already coming back with it — and all three were thrown away.
 * Only the timestamp was used, to answer "is a high-impact release due in the
 * next 24h" for the S4 penalty. So the system knew a release was *coming* and
 * then had nothing to say about it once it *arrived*, which is precisely the
 * half that changes price.
 *
 * ## Why FRED and not a calendar API
 *
 * A calendar with market consensus is the better input, but every free one puts
 * it behind a key and most put it behind a paid tier. FRED publishes the same
 * actuals, keyless, at the same time the release hits the wire. What FRED
 * cannot give is the *expectation*, so a FRED-only reading compares against the
 * previous print, and says so in the evidence rather than dressing it up as a
 * surprise. When a Finnhub key is present and the calendar returns an
 * `estimate`, the comparison upgrades to a real 市場預期 surprise.
 *
 * ## Why the direction is a channel, not a table
 *
 * Nine symbols × a dozen releases is a hundred hand-written directions to get
 * wrong. Almost all of these releases reach every instrument through the same
 * pipe: they change what the market thinks US rates will do, which moves the
 * dollar, which moves everything priced in dollars. So a release declares only
 * what a hotter-than-baseline print does to the dollar, and each symbol's
 * existing `dxyInverted` flag — already used and already tested for the DXY
 * trend factor — converts that into a direction.
 */

/** What a *higher than baseline* print does to the dollar. */
export type UsdImpact = "stronger" | "weaker";

export interface TrackedRelease {
  /** FRED series id — the keyless CSV endpoint serves all of these. */
  seriesId: string;
  label: string;
  /**
   * Names this release goes by on an economic calendar, lowercased. Used to
   * match a Finnhub calendar row so its `estimate` can upgrade the comparison.
   * Matching is substring-based, so keep these distinctive.
   */
  calendarAliases: string[];
  usdImpact: UsdImpact;
  /**
   * How long the print stays a *factor* rather than history.
   *
   * Not a guess about when the market finishes repricing — it's how long the
   * event is still the reason for the move. After this it drops out entirely
   * rather than fading, because a half-weighted CPI from three days ago is
   * indistinguishable from noise in the total.
   */
  impactHours: number;
  /** Weight ceiling while inside the window. Reserved for the prints that reprice curves. */
  weight: 1 | 2;
  /** Change smaller than this (in %, versus the baseline) is not news. */
  minChangePct: number;
  note: string;
}

/**
 * Ordered by how hard the print typically moves the dollar.
 *
 * Deliberately short. Every entry here is a release whose *direction* is
 * unambiguous through the rates channel; anything where a hot print is
 * genuinely two-sided (housing starts, trade balance) is left out rather than
 * given a coin-flip direction.
 */
export const TRACKED_RELEASES: TrackedRelease[] = [
  {
    seriesId: "CPIAUCSL",
    label: "美國 CPI",
    calendarAliases: ["cpi", "consumer price index"],
    // Hot inflation → higher-for-longer rates → dollar bid.
    usdImpact: "stronger",
    impactHours: 48,
    weight: 2,
    minChangePct: 0.05,
    note: "月頻，市場最看重的通膨數據",
  },
  {
    seriesId: "PCEPILFE",
    label: "美國 核心 PCE",
    calendarAliases: ["core pce", "pce price index"],
    usdImpact: "stronger",
    impactHours: 48,
    weight: 2,
    minChangePct: 0.05,
    note: "聯準會偏好的通膨指標",
  },
  {
    seriesId: "PAYEMS",
    label: "美國 非農就業",
    calendarAliases: ["nonfarm", "non-farm", "payroll"],
    // A strong labour market pushes rate-cut expectations further out.
    usdImpact: "stronger",
    impactHours: 48,
    weight: 2,
    minChangePct: 0.05,
    note: "月頻，就業數據中影響最大的一個",
  },
  {
    seriesId: "DFEDTARU",
    label: "聯準會 政策利率上緣",
    calendarAliases: ["fed interest rate", "fomc", "federal funds"],
    usdImpact: "stronger",
    // A rate decision reprices the whole curve; it stays the story for days.
    impactHours: 72,
    weight: 2,
    minChangePct: 0.01,
    note: "只在 FOMC 調整時才會變動",
  },
  {
    seriesId: "UNRATE",
    label: "美國 失業率",
    calendarAliases: ["unemployment rate"],
    // Inverted: a *higher* unemployment rate is a weaker economy, so a hotter
    // print here weakens the dollar. The one entry where up is dovish.
    usdImpact: "weaker",
    impactHours: 48,
    weight: 1,
    minChangePct: 0.5,
    note: "與其他就業數據方向相反：失業率上升＝經濟轉弱＝美元偏空",
  },
  {
    seriesId: "ICSA",
    label: "美國 初領失業金",
    calendarAliases: ["initial jobless", "jobless claims"],
    // Also inverted — more claims is a weaker labour market.
    usdImpact: "weaker",
    // Weekly and noisy: it matters for a day, not a week.
    impactHours: 24,
    weight: 1,
    minChangePct: 3,
    note: "週頻，噪音大，只有大幅偏離才有意義",
  },
  {
    seriesId: "RSAFS",
    label: "美國 零售銷售",
    calendarAliases: ["retail sales"],
    usdImpact: "stronger",
    impactHours: 24,
    weight: 1,
    minChangePct: 0.3,
    note: "消費動能，對利率預期的影響次於通膨與就業",
  },
];

export function releaseBySeriesId(seriesId: string): TrackedRelease | undefined {
  return TRACKED_RELEASES.find((r) => r.seriesId === seriesId);
}

/**
 * Converts a dollar impact into a direction for one instrument.
 *
 * Same rule the DXY trend factor uses, deliberately: `dxyInverted` marks the
 * pairs quoted the other way round (USD/JPY rises when the dollar does), and
 * having two different pieces of code decide "what does a strong dollar mean
 * for this symbol" is how the two eventually disagree.
 */
export function directionFromUsd(
  impact: UsdImpact,
  dxyInverted: boolean,
): "long" | "short" {
  const usdWeaker = impact === "weaker";
  return usdWeaker !== dxyInverted ? "long" : "short";
}

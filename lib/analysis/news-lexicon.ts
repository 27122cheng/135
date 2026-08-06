/**
 * Keyword-based news sentiment — the zero-key fallback for 新聞面.
 *
 * This is deliberately crude: it counts bullish/bearish financial terms in
 * headlines. It is NOT a substitute for the AI scorer, which reads the whole
 * headline in context and can tell "gold rallies" from "gold rally fades".
 * Because of that its output is capped at weight 1 (the AI path can reach 2)
 * and every bias item it produces says it came from keyword matching, so a
 * reader is never misled about where the number came from.
 */

const BULLISH = [
  // Movement
  "surge", "surges", "surged", "rally", "rallies", "rallied", "jump", "jumps", "jumped",
  "soar", "soars", "soared", "climb", "climbs", "climbed", "gain", "gains", "gained",
  "rise", "rises", "rose", "rebound", "rebounds", "rebounded", "advance", "advances",
  "advanced", "higher", "up", "lift", "lifts", "lifted", "boost", "boosts", "boosted",
  "extend gains", "firmer", "strengthen", "strengthens", "strengthened", "recover",
  "recovers", "recovered", "bounce", "bounces", "bounced", "top", "tops", "topped",
  // Levels
  "record high", "all-time high", "multi-year high", "peak", "peaks",
  // Stance
  "bullish", "upbeat", "optimism", "optimistic", "beat expectations",
  "stronger than expected", "better than expected", "rate cut", "rate cuts", "dovish",
  "easing", "stimulus", "safe haven", "haven demand", "inflows", "upgrade", "upgrades",
  "outperform", "buying", "demand rises", "支撐", "上漲", "走高", "反彈", "看多", "利多",
  "創高", "新高", "買盤", "降息", "寬鬆", "避險需求",
];

const BEARISH = [
  // Movement
  "plunge", "plunges", "plunged", "slump", "slumps", "slumped", "tumble", "tumbles",
  "tumbled", "fall", "falls", "fell", "drop", "drops", "dropped", "slide", "slides",
  "slid", "sink", "sinks", "sank", "decline", "declines", "declined", "lower",
  "down", "retreat", "retreats", "retreated", "weaken", "weakens", "weakened",
  "softer", "slip", "slips", "slipped", "pressure", "pressured", "weigh", "weighs",
  "weighed", "extend losses", "erase gains",
  // Levels
  "record low", "multi-year low", "trough",
  // Stance
  "selloff", "sell-off", "bearish", "downbeat", "pessimism", "miss expectations",
  "weaker than expected", "worse than expected", "rate hike", "rate hikes", "hawkish",
  "tightening", "recession", "outflows", "downgrade", "downgrades", "underperform",
  "profit taking", "profit-taking", "selling", "壓力", "下跌", "走低", "回落", "看空",
  "利空", "創低", "新低", "賣壓", "升息", "緊縮", "獲利了結",
];

/**
 * Words that flip the sense of a nearby term ("rally fades", "not bullish").
 *
 * `"no "` and `"not "` used to be matched as substrings, which meant "casino"
 * and "cannot" silently inverted a headline's lean. Everything here now matches
 * on word boundaries like the rest.
 */
const NEGATORS = [
  "fade", "fades", "faded", "stall", "stalls", "stalled", "not", "no", "fails",
  "failed", "reverses", "reversed", "pares", "pared", "trims", "trimmed",
];

/**
 * Terms that mean "we read it and it wasn't leaning either way".
 *
 * The difference between a quiet news day and an unreadable one is real
 * information, and without this list they came out identical: 25 gold headlines
 * about spot prices holding steady scored zero, and the card reported a data
 * gap — "無可辨識的多空關鍵字" — for news it had in fact read perfectly well.
 */
const NEUTRAL = [
  "steady", "flat", "unchanged", "little changed", "little-changed", "mixed",
  "holds", "hold", "range", "rangebound", "range-bound", "consolidate",
  "consolidates", "consolidating", "await", "awaits", "awaiting", "ahead of",
  "eyes", "watch", "watches", "sideways", "muted", "quiet", "盤整", "持平",
  "觀望", "橫盤", "震盪",
];

export interface LexiconSentiment {
  /** -1 .. +1 */
  score: number;
  bullishHits: number;
  bearishHits: number;
  /** Headlines that contributed a direction, for the evidence string. */
  matched: number;
  /**
   * Headlines that matched a term meaning "no lean" — steady, flat, awaiting.
   *
   * Separated from `matched` because they answer a different question. A day
   * with 20 of these is a quiet market, which is a finding; a day with none of
   * anything is a lexicon that couldn't read the headlines, which is a gap.
   */
  neutralMatched: number;
}

/**
 * Word-boundary matching, compiled once.
 *
 * `text.includes("gain")` is true of "against", "bargain" and "campaign";
 * `includes("fall")` is true of "shortfall" and "fallout"; `includes("up")` is
 * true of almost everything. Substring matching over a financial lexicon does
 * not produce a slightly noisy score, it produces a score of the wrong sign.
 *
 * `\b` around a CJK term does not behave the way it does around ASCII, so
 * those fall back to a plain substring test — which is correct for Chinese,
 * where there are no spaces to anchor to.
 */
const CJK = /[\u4e00-\u9fff]/;

function compile(terms: string[]): Array<{ term: string; test: (t: string) => boolean }> {
  return terms.map((term) => {
    if (CJK.test(term)) return { term, test: (t: string) => t.includes(term) };
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    return { term, test: (t: string) => re.test(t) };
  });
}

const BULLISH_MATCHERS = compile(BULLISH);
const BEARISH_MATCHERS = compile(BEARISH);
const NEUTRAL_MATCHERS = compile(NEUTRAL);
const NEGATOR_MATCHERS = compile(NEGATORS);

function countHits(text: string, matchers: ReturnType<typeof compile>): number {
  let n = 0;
  for (const m of matchers) {
    if (m.test(text)) n++;
  }
  return n;
}

export function scoreHeadlines(headlines: string[]): LexiconSentiment {
  let bullishHits = 0;
  let bearishHits = 0;
  let matched = 0;
  let neutralMatched = 0;

  for (const raw of headlines) {
    const text = raw.toLowerCase();
    let bull = countHits(text, BULLISH_MATCHERS);
    let bear = countHits(text, BEARISH_MATCHERS);
    if (bull === 0 && bear === 0) {
      if (countHits(text, NEUTRAL_MATCHERS) > 0) neutralMatched++;
      continue;
    }
    matched++;
    // A negator in the headline inverts its lean rather than adding noise.
    if (countHits(text, NEGATOR_MATCHERS) > 0) {
      [bull, bear] = [bear, bull];
    }
    bullishHits += bull;
    bearishHits += bear;
  }

  const total = bullishHits + bearishHits;
  const score = total === 0 ? 0 : (bullishHits - bearishHits) / total;
  return {
    score: Math.max(-1, Math.min(1, score)),
    bullishHits,
    bearishHits,
    matched,
    neutralMatched,
  };
}

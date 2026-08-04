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
  "surge",
  "surges",
  "rally",
  "rallies",
  "rallied",
  "jump",
  "jumps",
  "soar",
  "soars",
  "climb",
  "climbs",
  "gain",
  "gains",
  "rise",
  "rises",
  "rebound",
  "record high",
  "all-time high",
  "bullish",
  "upbeat",
  "beat expectations",
  "stronger than expected",
  "rate cut",
  "dovish",
  "stimulus",
  "safe haven",
  "inflows",
  "upgrade",
  "outperform",
];

const BEARISH = [
  "plunge",
  "plunges",
  "slump",
  "slumps",
  "tumble",
  "tumbles",
  "fall",
  "falls",
  "drop",
  "drops",
  "slide",
  "slides",
  "sink",
  "sinks",
  "decline",
  "declines",
  "selloff",
  "sell-off",
  "bearish",
  "downbeat",
  "miss expectations",
  "weaker than expected",
  "rate hike",
  "hawkish",
  "recession",
  "outflows",
  "downgrade",
  "underperform",
  "profit taking",
  "profit-taking",
];

/** Words that flip the sense of a nearby term ("rally fades", "not bullish"). */
const NEGATORS = ["fade", "fades", "faded", "stall", "stalls", "not ", "no ", "fails", "failed"];

export interface LexiconSentiment {
  /** -1 .. +1 */
  score: number;
  bullishHits: number;
  bearishHits: number;
  /** Headlines that contributed, for the evidence string. */
  matched: number;
}

function countHits(text: string, terms: string[]): number {
  let n = 0;
  for (const term of terms) {
    if (text.includes(term)) n++;
  }
  return n;
}

export function scoreHeadlines(headlines: string[]): LexiconSentiment {
  let bullishHits = 0;
  let bearishHits = 0;
  let matched = 0;

  for (const raw of headlines) {
    const text = raw.toLowerCase();
    let bull = countHits(text, BULLISH);
    let bear = countHits(text, BEARISH);
    if (bull === 0 && bear === 0) continue;
    matched++;
    // A negator in the headline inverts its lean rather than adding noise.
    if (NEGATORS.some((n) => text.includes(n))) {
      [bull, bear] = [bear, bull];
    }
    bullishHits += bull;
    bearishHits += bear;
  }

  const total = bullishHits + bearishHits;
  const score = total === 0 ? 0 : (bullishHits - bearishHits) / total;
  return { score: Math.max(-1, Math.min(1, score)), bullishHits, bearishHits, matched };
}

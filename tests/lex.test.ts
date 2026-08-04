import { check, report } from "./_harness";
import { scoreHeadlines } from "@/lib/analysis/news-lexicon";

const bull = scoreHeadlines([
  "Gold surges to record high as Fed signals rate cut",
  "Bullion rallies on safe haven demand",
  "Gold ETF inflows climb for third week",
]);
console.log("bullish:", bull);
check("bullish", bull.score > 0.5 && bull.matched === 3);

const bear = scoreHeadlines([
  "Gold plunges as dollar strengthens on hawkish Fed",
  "Bullion tumbles amid profit-taking",
]);
console.log("bearish:", bear);
check("bearish", bear.score < -0.5 && bear.matched === 2);

// Negation must flip, not add noise.
const neg = scoreHeadlines(["Gold rally fades as buyers stall"]);
console.log("negated:", neg);
check("neutral", neg.score < 0, `FAIL negation should flip, got ${neg.score}`);

// Headlines with no signal words must not be counted at all.
const none = scoreHeadlines(["Gold market opens Monday", "Analyst discusses metals"]);
console.log("neutral:", none);
console.assert(none.matched === 0 && none.score === 0);

report("lex");

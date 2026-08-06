import { check, report } from "./_harness";
import { scoreHeadlines } from "@/lib/analysis/news-lexicon";

/**
 * The zero-key news scorer, after 25 gold headlines scored exactly nothing and
 * the card reported a data gap for news it had read perfectly well.
 *
 * Two separate defects: the vocabulary was too narrow for the language real
 * financial headlines use, and the matching was substring-based, which is not
 * "slightly noisy" — it is wrong-signed.
 */

// ── substring matching was inverting headlines ────────────────────
{
  // "against" contains "gain". "shortfall" contains "fall". "casino" contains
  // "no ". Each of those used to score, and the last one *flipped* the
  // headline's direction on its way past.
  const traps = [
    "Gold prices steady against the dollar",
    "Budget shortfall widens as spending grows",
    "Casino stocks in focus ahead of earnings",
    "Campaign spending hits new levels",
  ];
  const r = scoreHeadlines(traps);
  // None of these four contains a whole directional word, so none of them may
  // contribute one. Under substring matching three of them did.
  check("word fragments contribute nothing", r.matched === 0, r);
  check("and nothing was scored either way", r.bullishHits === 0 && r.bearishHits === 0, r);

  // Whole words still match.
  const real = scoreHeadlines(["Gold gains as dollar falls"]);
  check("a real word still matches", real.matched === 1, real);
}

// ── the vocabulary real headlines use ─────────────────────────────
{
  const bullish = scoreHeadlines([
    "Spot gold edges higher on haven demand",
    "Gold climbs as Fed signals rate cuts",
    "Bullion extends gains for a third session",
  ]);
  check("ordinary bullish phrasing is read", bullish.score > 0.3, bullish);

  const bearish = scoreHeadlines([
    "Gold slips as dollar strengthens",
    "Bullion under pressure ahead of hawkish Fed",
    "Gold retreats from record",
  ]);
  check("ordinary bearish phrasing is read", bearish.score < -0.1, bearish);

  // GDELT returns Chinese headlines too, and the table had none.
  const chinese = scoreHeadlines(["黃金價格走高，買盤湧入", "金價上漲創新高"]);
  check("Chinese headlines are read", chinese.matched === 2 && chinese.score > 0, chinese);
}

// ── a quiet day is a finding, not a gap ───────────────────────────
{
  // This is the case from the screenshot: 25 headlines, all about prices
  // holding while the market waits. The old lexicon reported "無可辨識的多空
  // 關鍵字" — a data gap — for news it had read fine.
  const quiet = scoreHeadlines([
    "Gold steady as investors await US inflation data",
    "Spot gold little changed in Asian trade",
    "Gold holds within a narrow range ahead of the Fed",
    "金價盤整，市場觀望",
  ]);
  check("a quiet day scores no direction", quiet.matched === 0, quiet);
  check("but is recognised as quiet, not unreadable", quiet.neutralMatched === 4, quiet);

  // And genuinely unreadable headlines stay unreadable — the distinction only
  // means something if both sides of it exist.
  const opaque = scoreHeadlines(["Company X names new chief financial officer"]);
  check("an unrelated headline is neither", opaque.matched === 0 && opaque.neutralMatched === 0,
    opaque);
}

// ── negation still flips, without the false positives ─────────────
{
  const faded = scoreHeadlines(["Gold rally fades as dollar recovers"]);
  check("a faded rally does not read as bullish", faded.score <= 0, faded);
}

report("news lexicon");

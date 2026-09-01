import { check, report } from "./_harness";
import { correlatedExposure, streakFactor, usdSide } from "@/lib/analysis/exposure";
import { positionSize } from "@/lib/analysis/sizing";

/**
 * 回撤過高 is a stacking problem: three "different" instruments that are one
 * dollar view, all stopping out on the same move. The sizing card's check
 * read the correlation cluster list without its sign and without either
 * position's direction, so it halved a hedge and let a stack through. The
 * documented USD-side rule was never implemented at all.
 */

// ── the dollar side ───────────────────────────────────────────────
{
  check("long EURUSD is short the dollar", usdSide("EURUSD", "long") === "short-usd");
  check("long USDJPY is long the dollar", usdSide("USDJPY", "long") === "long-usd");
  check("long gold is short the dollar", usdSide("XAUUSD", "long") === "short-usd");
  check("short GBPUSD is long the dollar", usdSide("GBPUSD", "short") === "long-usd");
  check("an index is not a dollar bet by rule", usdSide("SPX500", "long") === null);
  check("crypto is not a dollar bet by rule", usdSide("BTCUSD", "long") === null);
}

// ── same bet vs hedge ─────────────────────────────────────────────
{
  const noClusters: { a: string; b: string; r: number | null }[] = [];

  // The stack the old check let through: r(EURUSD,XAUUSD) ≈ 0.4 is under the
  // cluster threshold, yet both are plainly short-USD.
  const stack = correlatedExposure({
    symbol: "XAUUSD", direction: "long",
    held: [{ symbol: "EURUSD", direction: "long" }, { symbol: "GBPUSD", direction: "long" }],
    clusters: noClusters,
  });
  check("same-side dollar bets count without any correlation window",
    stack.related.length === 2, stack);
  check("the third copy of one view risks a third", stack.factor === 1 / 3, stack.factor);
  check("and says which rule matched", stack.reasons.every((r) => r.includes("空美元")), stack.reasons);

  // The hedge the old check cut: EURUSD long beside USDJPY long are opposite
  // dollar bets, and their r is strongly negative.
  const hedge = correlatedExposure({
    symbol: "EURUSD", direction: "long",
    held: [{ symbol: "USDJPY", direction: "long" }],
    clusters: [{ a: "EURUSD", b: "USDJPY", r: -0.8 }],
  });
  check("a hedge is not a stack", hedge.related.length === 0 && hedge.factor === 1, hedge);

  // Signed correlation on instruments with no dollar side.
  const sameDir = correlatedExposure({
    symbol: "NAS100", direction: "long",
    held: [{ symbol: "SPX500", direction: "long" }],
    clusters: [{ a: "SPX500", b: "NAS100", r: 0.9 }],
  });
  check("positive r, same direction — same bet", sameDir.related.length === 1, sameDir);
  const oppDir = correlatedExposure({
    symbol: "NAS100", direction: "short",
    held: [{ symbol: "SPX500", direction: "long" }],
    clusters: [{ a: "SPX500", b: "NAS100", r: 0.9 }],
  });
  check("positive r, opposite direction — a hedge", oppDir.related.length === 0, oppDir);
  const negOpp = correlatedExposure({
    symbol: "US30", direction: "short",
    held: [{ symbol: "WTI", direction: "long" }],
    clusters: [{ a: "US30", b: "WTI", r: -0.75 }],
  });
  check("negative r, opposite direction — same bet", negOpp.related.length === 1, negOpp);

  check("the symbol being sized never counts itself",
    correlatedExposure({
      symbol: "EURUSD", direction: "long",
      held: [{ symbol: "EURUSD", direction: "long" }], clusters: noClusters,
    }).related.length === 0);
  check("a null r is not evidence",
    correlatedExposure({
      symbol: "NAS100", direction: "long",
      held: [{ symbol: "SPX500", direction: "long" }],
      clusters: [{ a: "SPX500", b: "NAS100", r: null }],
    }).related.length === 0);
}

// ── 連敗減碼 ──────────────────────────────────────────────────────
{
  check("no streak, full size", streakFactor(0) === 1 && streakFactor(1) === 1);
  check("two losses, three-quarters", streakFactor(2) === 0.75);
  check("three or more, half", streakFactor(3) === 0.5 && streakFactor(7) === 0.5);
}

// ── both factors reach the number the card shows ──────────────────
{
  const base = { accountSize: 10_000, riskPct: 1, direction: "long" as const, entry: 100, stopLoss: 99, symbol: "EURUSD" };
  const clean = positionSize(base)!;
  check("baseline risks the full 1%", clean.riskAmount === 100 && clean.correlationFactor === 1 && clean.streakFactor === 1);

  const stacked = positionSize({ ...base, correlatedHeld: ["GBPUSD", "XAUUSD"], correlatedReasons: ["a", "b"] })!;
  check("two same-bet positions cut the third to a third",
    Math.abs(stacked.riskAmount - 100 / 3) < 0.01 && stacked.correlationFactor === 1 / 3, stacked);
  check("and the note explains the split", stacked.notes.some((n) => n.includes("1/3")), stacked.notes);

  const streaky = positionSize({ ...base, lossStreak: 3 })!;
  check("a three-loss streak halves the risk", streaky.riskAmount === 50 && streaky.streakFactor === 0.5, streaky);
  check("and says why", streaky.notes.some((n) => n.includes("連敗減碼")), streaky.notes);

  const both = positionSize({ ...base, correlatedHeld: ["GBPUSD"], lossStreak: 2 })!;
  check("the factors compound", Math.abs(both.riskAmount - 100 * 0.5 * 0.75) < 0.01, both.riskAmount);

  // Sizing is volume-neutral by construction: a factor can shrink a position,
  // never refuse one.
  check("no factor can refuse the trade", positionSize({ ...base, correlatedHeld: ["a", "b", "c", "d"], lossStreak: 9 }) !== null);
}

report("exposure + drawdown sizing");

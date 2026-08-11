import { check, report } from "./_harness";
import { analyzeTechnical } from "@/lib/analysis/technical";
import type { Candle } from "@/lib/data-sources/ohlcv";

/**
 * 「把每項技術分析的數據及結論顯示出來」.
 *
 * The card's technical section could not answer "所以 RSI 現在多少？" — the
 * value was computed on every scan and thrown away unless a divergence
 * happened to exist. The invariant pinned here: every core indicator (swing
 * structure, EMA alignment, RSI, MACD) produces a bias item on every run with
 * enough candles, so the UI's 技術指標明細 always has a reading to show. A
 * neutral verdict must arrive as a weight-0 item, never as silence — "the
 * indicator is neutral" and "the indicator wasn't computed" are different
 * facts.
 */

function candles(n: number, price: (i: number) => number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const p = price(i);
    return {
      time: new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString(),
      open: p,
      high: p * 1.004,
      low: p * 0.996,
      close: p,
      volume: 1000,
    };
  });
}

{
  // A meandering market: no clean trend, so structure and EMA come back
  // neutral — which must still be *said*, with the numbers attached.
  const flat = candles(260, (i) => 100 + Math.sin(i / 9) * 3);
  const gaps: string[] = [];
  const r = analyzeTechnical({ D1: flat }, 100, 2, gaps);
  const tech = r.biasItems.filter((b) => b.dimension === "技術面");

  const rsiItem = tech.find((b) => b.factor.includes("RSI(14)"));
  check("RSI always reports its reading", rsiItem !== undefined, tech.map((b) => b.factor));
  check("as a fact, not a vote", rsiItem?.weight === 0 && rsiItem?.direction === "neutral", rsiItem);
  check("with the value in the evidence", /RSI\(14\)=\d/.test(rsiItem?.evidence ?? ""),
    rsiItem?.evidence);
  check("and a zone verdict in the conclusion",
    /超買|超賣|中性/.test(rsiItem?.factor ?? ""), rsiItem?.factor);

  const emaItem = tech.find((b) => b.factor.includes("EMA"));
  check("EMA alignment reports even when mixed", emaItem !== undefined, tech.map((b) => b.factor));
  check("with all three values", /EMA20=.*EMA50=.*EMA200=/.test(emaItem?.evidence ?? ""),
    emaItem?.evidence);

  check("MACD reports its histogram", tech.some((b) => b.factor.includes("MACD")), undefined);
  check("structure reports even when mixed", tech.some((b) => b.factor.includes("結構")), undefined);
}

{
  // A trending market: the same indicators now vote, and the readings carry
  // the numbers that justify the vote.
  const trend = candles(260, (i) => 100 + i * 0.8 + Math.sin(i / 5) * 1.5);
  const r = analyzeTechnical({ D1: trend }, 100 + 259 * 0.8, 3, []);
  const tech = r.biasItems.filter((b) => b.dimension === "技術面");
  const ema = tech.find((b) => b.factor.includes("EMA"));
  check("a real trend turns the EMA item into a vote", ema?.direction === "long" && ema.weight === 2,
    ema);
  const rsiItem = tech.find((b) => b.factor.includes("RSI(14)"));
  check("the RSI reading is still there alongside the votes", rsiItem !== undefined, undefined);
}

report("technical readings");

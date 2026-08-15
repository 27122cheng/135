import { check, report } from "./_harness";
import { candleSignals, falseBreakSignal, unfilledGapSignal } from "@/lib/analysis/candles";
import { efficiencyRatio } from "@/lib/analysis/indicators";
import { analyzeTechnical } from "@/lib/analysis/technical";
import type { EntryStructure } from "@/types/signal";
import type { Candle } from "@/lib/data-sources/ohlcv";

/**
 * Trend maturity + 裸K reversal signals.
 *
 * The immaturities being pinned away: a trend call flipped by one noisy
 * pivot, an all-or-nothing EMA vote, trend votes priced the same in chop as
 * in a real trend, and candle shapes voting with no structure behind them.
 */

function bar(time: string, o: number, h: number, l: number, c: number): Candle {
  return { time, open: o, high: h, low: l, close: c, volume: 1000 };
}

/** A steady uptrend with real pullbacks — swings exist and keep ascending. */
function uptrend(n: number, start = 100): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    // Drift 0.4/bar with a ~25-bar wave of amplitude 4: pullbacks are deep
    // enough to print swing pivots, shallow enough that pivots still ascend.
    const base = start + i * 0.4 + Math.sin(i / 4) * 4;
    out.push(bar(`2026-01-${String((i % 28) + 1).padStart(2, "0")}`, base, base + 0.8, base - 0.8, base + 0.3));
  }
  return out;
}

/** A round trip: big amplitude, no net progress — the chop regime. */
function chop(n: number, start = 100): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const base = start + Math.sin(i / 4) * 6;
    out.push(bar(`2026-02-${String((i % 28) + 1).padStart(2, "0")}`, base, base + 1, base - 1, base + 0.2));
  }
  return out;
}

// ── efficiency ratio ──────────────────────────────────────────────
{
  const straight = Array.from({ length: 30 }, (_, i) => 100 + i);
  check("a straight line is fully efficient", efficiencyRatio(straight, 20) === 1);
  const wave = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 5);
  check("a round trip is inefficient", (efficiencyRatio(wave, 20) ?? 1) < 0.2, efficiencyRatio(wave, 20));
  check("too little data yields null", efficiencyRatio([1, 2, 3], 20) === null);
}

// ── trend maturity through the full analyzer ──────────────────────
{
  const up = uptrend(220);
  const r = analyzeTechnical({ D1: up }, up.at(-1)!.close, 2, []);
  const structureItem = r.biasItems.find((i) => i.factor.includes("D1 結構"));
  check("a sustained uptrend reads HH/HL", structureItem?.direction === "long", structureItem?.factor);
  check("two agreeing legs make it 成熟 at weight 2",
    structureItem?.factor.includes("成熟趨勢") === true && structureItem?.weight === 2,
    structureItem?.factor);
  const emaItem = r.biasItems.find((i) => i.factor.includes("EMA"));
  check("the EMA vote agrees", emaItem?.direction === "long", emaItem?.factor);
  const erItem = r.biasItems.find((i) => i.factor.includes("效率比"));
  check("trend quality is stated", erItem !== undefined && erItem.weight === 0, erItem?.factor);
  check("and reads as trending", erItem?.factor.includes("趨勢行進中") === true, erItem?.factor);
}

{
  const flat = chop(220);
  const r = analyzeTechnical({ D1: flat }, flat.at(-1)!.close, 2, []);
  const erItem = r.biasItems.find((i) => i.factor.includes("效率比"));
  check("chop is named as chop", erItem?.factor.includes("盤整") === true, erItem?.factor);
  // The discount: no 技術面 trend vote in a round trip may claim weight 2.
  const trendVotes = r.biasItems.filter(
    (i) => (i.factor.includes("D1 結構") || i.factor.includes("EMA")) && i.direction !== "neutral",
  );
  check("no trend vote claims full conviction in chop",
    trendVotes.every((i) => i.weight <= 1), trendVotes.map((i) => `${i.factor}=${i.weight}`));
}

// ── W1 anchor ─────────────────────────────────────────────────────
{
  const up = uptrend(220);
  const w1 = uptrend(60, 90);
  const r = analyzeTechnical({ D1: up, W1: w1 }, up.at(-1)!.close, 2, []);
  const w1Item = r.biasItems.find((i) => i.factor.startsWith("W1"));
  check("the weekly timeframe votes", w1Item?.direction === "long" && w1Item.weight === 1, w1Item?.factor);
}

// ── 裸K signals ───────────────────────────────────────────────────
{
  const support: EntryStructure = {
    price: 98, type: "前低", role: "support", timeframe: "D1", strength: 2, distance_pct: -2,
  };
  const resistance: EntryStructure = {
    price: 106, type: "前高", role: "resistance", timeframe: "D1", strength: 2, distance_pct: 2,
  };

  // Bullish engulfing whose low tests the support at 98 (ATR = 2).
  const engulf = [
    bar("d1", 101, 102, 100, 100.2),
    bar("d2", 100.2, 100.5, 98.2, 99), // bearish
    bar("d3", 98.8, 101.5, 98.1, 100.8), // bullish, engulfs, low at 98.1 near 98
    bar("d4-forming", 100.8, 101, 100.5, 100.9),
  ];
  const anchored = candleSignals("D1", engulf, 2, [support, resistance]);
  check("an engulfing at support votes long",
    anchored.length === 1 && anchored[0].direction === "long" && anchored[0].weight === 1,
    anchored);
  check("and names the structure it tested",
    anchored[0]?.factor.includes("看漲吞噬") === true && anchored[0]?.factor.includes("前低") === true,
    anchored[0]?.factor);

  // The same shape with no structure anywhere near: recorded, not voting.
  const unanchored = candleSignals("D1", engulf, 2, [resistance]);
  check("the same shape without structure does not vote",
    unanchored.length === 1 && unanchored[0].weight === 0 && unanchored[0].direction === "neutral",
    unanchored);
  check("and says why", unanchored[0]?.factor.includes("僅記錄不投票") === true, unanchored[0]?.factor);

  // A hammer: long lower wick into support, small body.
  const hammer = [
    bar("d1", 102, 103, 101, 101.5),
    bar("d2", 101.5, 102, 101, 101.2),
    bar("d3", 101.2, 101.6, 97.9, 101.4), // wick to 97.9, body 0.2, tests 98
    bar("d4-forming", 101.4, 102, 101, 101.8),
  ];
  const pin = candleSignals("D1", hammer, 2, [support]);
  check("a hammer at support votes long",
    pin.length === 1 && pin[0].direction === "long" && pin[0].factor.includes("錘子"), pin);

  // The forming bar must not be the one examined: put the signal at -1 and
  // nothing should fire, because -1 is still open.
  const formingOnly = [
    bar("d1", 101, 102, 100, 100.2),
    bar("d2", 100.2, 100.5, 99.8, 100),
    bar("d3", 100, 100.4, 99.9, 100.1),
    bar("d4-forming", 99.9, 101.5, 98.1, 100.9), // engulfing shape, but still forming
  ];
  check("a forming bar does not testify", candleSignals("D1", formingOnly, 2, [support]).length === 0);

  // An ordinary bar is silence, not a neutral item.
  const quiet = [
    bar("d1", 100, 101, 99.5, 100.5),
    bar("d2", 100.5, 101.2, 100, 100.8),
    bar("d3", 100.8, 101.4, 100.4, 101),
    bar("d4-forming", 101, 101.5, 100.8, 101.2),
  ];
  check("no shape means no item", candleSignals("D1", quiet, 2, [support]).length === 0);
}

// ── 假突破 Spring / Upthrust ──────────────────────────────────────
{
  const support: EntryStructure = {
    price: 98, type: "前低", role: "support", timeframe: "D1", strength: 2, distance_pct: -2,
  };
  const resistance: EntryStructure = {
    price: 106, type: "前高", role: "resistance", timeframe: "D1", strength: 2, distance_pct: 2,
  };

  // Wick to 97.2 (through 98 by more than 0.15×ATR=0.3), closing back above,
  // and price still above today.
  const spring = [
    bar("d1", 100, 101, 99.5, 100),
    bar("d2", 100, 100.5, 99.4, 99.8),
    bar("d3", 99.8, 100.2, 97.2, 99.6),
    bar("d4", 99.6, 100.4, 99.3, 100.1),
    bar("forming", 100.1, 100.5, 99.9, 100.2),
  ];
  const sp = falseBreakSignal("D1", spring, 2, [support, resistance]);
  check("a wick through support that closes back above is a Spring",
    sp?.direction === "long" && sp.factor.includes("假跌破"), sp?.factor);
  check("and it outweighs a plain reversal candle", sp?.weight === 2, sp?.weight);

  // The same pierce, but price has since given the level up — not a spring.
  const brokeDown = [...spring.slice(0, 4), bar("forming", 97.5, 97.8, 97.1, 97.4)];
  const gone = falseBreakSignal("D1", [...brokeDown.slice(0, 4), bar("d5", 97.4, 97.6, 97, 97.2), brokeDown[4]], 2, [support]);
  check("a level that has since given way is not a Spring", gone === null, gone?.factor);

  // Mirror: wick above resistance, close back under.
  const upthrust = [
    bar("d1", 104, 105, 103.5, 104),
    bar("d2", 104, 105.2, 103.8, 104.5),
    bar("d3", 104.5, 107.1, 104.2, 105.4),
    bar("d4", 105.4, 105.9, 104.8, 105.2),
    bar("forming", 105.2, 105.6, 104.9, 105.1),
  ];
  const ut = falseBreakSignal("D1", upthrust, 2, [resistance]);
  check("a wick through resistance that closes back under is an Upthrust",
    ut?.direction === "short" && ut.factor.includes("假突破"), ut?.factor);

  // A touch is not a break.
  const touch = [
    bar("d1", 100, 101, 99.5, 100),
    bar("d2", 100, 100.5, 99.4, 99.8),
    bar("d3", 99.8, 100.2, 97.95, 99.6),
    bar("d4", 99.6, 100.4, 99.3, 100.1),
    bar("forming", 100.1, 100.5, 99.9, 100.2),
  ];
  check("a shallow touch is not a false break",
    falseBreakSignal("D1", touch, 2, [support]) === null);
}

// ── 未回補跳空 ────────────────────────────────────────────────────
{
  // A gap up between d2's high (100.5) and d3's low (103), never revisited.
  const gapped = [
    bar("d1", 99, 100, 98.5, 99.5),
    bar("d2", 99.5, 100.5, 99, 100),
    bar("d3", 103, 104, 103, 103.5),
    bar("d4", 103.5, 105, 103.2, 104.5),
    bar("d5", 104.5, 106, 104, 105.5),
    bar("d6", 105.5, 107, 105, 106.5),
    bar("d7", 106.5, 108, 106, 107.5),
    bar("d8", 107.5, 109, 107, 108.5),
    bar("d9", 108.5, 110, 108, 109.5),
    bar("d10", 109.5, 111, 109, 110.5),
  ];
  const g = unfilledGapSignal("D1", gapped);
  check("an unfilled gap is reported", g !== null, g);
  check("as position information, not a direction",
    g?.direction === "neutral" && g?.weight === 0, g);
  check("naming the side it sits on", g?.factor.includes("下方") === true, g?.factor);

  // The same gap, later filled by a pullback through it.
  const filled = [...gapped, bar("d11", 110.5, 111, 100, 101)];
  check("a filled gap stops being reported",
    unfilledGapSignal("D1", filled) === null, unfilledGapSignal("D1", filled)?.factor);

  const quiet = Array.from({ length: 12 }, (_, i) =>
    bar(`q${i}`, 100 + i * 0.1, 100.3 + i * 0.1, 99.8 + i * 0.1, 100.1 + i * 0.1));
  check("a continuous series has no gaps", unfilledGapSignal("D1", quiet) === null);
}

report("trend maturity + 裸K");

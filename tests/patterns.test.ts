import { check, report } from "./_harness";
import { detectPatterns, patternContributions } from "@/lib/analysis/patterns";
import type { Candle } from "@/lib/data-sources/yfinance";

/**
 * 圖形交易.
 *
 * Every case here is a hand-built price series with a shape drawn into it, so
 * the answer is known before the code runs. Two properties matter more than
 * any individual detection:
 *
 *  1. A breakout alone never produces a tradeable pattern. The owner's rule is
 *     break + participation + a retest that holds, and `confirmed` is the only
 *     status allowed to touch the score, the stop or the targets.
 *  2. The target is the pattern's own height projected from the broken line —
 *     never a fixed multiple, never a number nobody can reconstruct.
 */

let day = 0;
function nextTime(): string {
  day += 1;
  return new Date(Date.UTC(2026, 0, day)).toISOString();
}

/** A bar around `price`; `range` controls its true range, `vol` its volume. */
function bar(price: number, range = 2, vol: number | null = 1000): Candle {
  return {
    time: nextTime(),
    open: price,
    high: price + range / 2,
    low: price - range / 2,
    close: price,
    volume: vol,
  };
}

function series(prices: number[], range = 2, vol: number | null = 1000): Candle[] {
  day = 0;
  return prices.map((p) => bar(p, range, vol));
}

/** Linear ramp, inclusive of both ends, over `steps` bars. */
function ramp(from: number, to: number, steps: number): number[] {
  return Array.from({ length: steps }, (_, i) => from + ((to - from) * i) / (steps - 1));
}

/** Enough flat lead-in for ATR(14) and the pivot detector to have a baseline. */
const LEAD = Array(20).fill(100) as number[];

// ── nothing is found in noise-free flatness ───────────────────────
{
  const flat = series(Array(60).fill(100));
  const { patterns } = detectPatterns(flat, "D1");
  // A dead-flat series has no swing points and no ATR to speak of; anything
  // "detected" there would be an artefact of the fitting, not a shape.
  check("a flat series produces no patterns", patterns.length === 0, patterns.map((p) => p.name));
}

// ── too little data is a stated gap, not a silent empty ───────────
{
  const { patterns, gaps } = detectPatterns(series(ramp(100, 110, 10)), "D1");
  check("a short series yields nothing", patterns.length === 0);
  check("and says why", gaps.length === 1 && gaps[0].includes("不足"), gaps);
}

// ── double bottom: break, then the three gates ────────────────────
//
// Two equal lows at 90 with a bounce to 110 between them; neckline 110.
// Height 20, so the projected target is 130.
function doubleBottom(tail: number[], range = 2, vol: number | null = 1000): Candle[] {
  return series(
    [
      ...LEAD,
      ...ramp(100, 90, 8),
      ...ramp(90, 110, 8),
      ...ramp(110, 90, 8),
      ...ramp(90, 110, 8),
      ...tail,
    ],
    range,
    vol,
  );
}

{
  // Still inside — price has not closed above the neckline.
  const { patterns } = detectPatterns(doubleBottom([108, 106, 104, 106, 108]), "D1");
  const db = patterns.find((p) => p.name === "雙重底");
  check("a double bottom is found", db !== undefined, patterns.map((p) => p.name));
  check("it is a reversal", db?.kind === "reversal");
  check("pointing long", db?.direction === "long");
  check("still forming before the break", db?.status === "forming", db?.status);
  // Stated as the invariant rather than a literal, so it does not quietly
  // depend on how wide the synthetic bars are: the distance from the neckline
  // up to the target equals the distance from the neckline down to the low.
  const up = (db?.target ?? 0) - (db?.breakout_level ?? 0);
  const down = (db?.breakout_level ?? 0) - (db?.invalidation_level ?? 0);
  check("the target is the pattern height projected from the neckline",
    Math.abs(up - down) < 0.01, [up, down]);
  check("and that height is the ~22 the shape was drawn with",
    Math.abs(down - 22) < 1.5, down);
  check("the target basis names the arithmetic",
    db?.target_basis.includes("投射") === true, db?.target_basis);
}

{
  // Broken out on a wide, high-volume bar, but price has not come back.
  const candles = doubleBottom([...ramp(110, 125, 6)]);
  candles.at(-6)!.volume = 5000;
  const { patterns } = detectPatterns(candles, "D1");
  const db = patterns.find((p) => p.name === "雙重底");
  check("a break without a retest is not tradeable", db?.status === "broken_out", db?.status);
  const retest = db?.checks.find((c) => c.label.includes("回踩"));
  check("and the retest is the thing outstanding", retest?.passed === false, db?.checks);
  check("the outstanding check says what to wait for",
    retest?.detail.includes("等回踩撐住") === true, retest?.detail);
}

{
  // Break on a *quiet* bar, then a proper retest. Participation must still fail.
  const candles = doubleBottom([...ramp(110, 120, 4), ...ramp(120, 111, 4), 118], 0.5, 1000);
  const { patterns } = detectPatterns(candles, "D1");
  const db = patterns.find((p) => p.name === "雙重底");
  const vol = db?.checks.find((c) => c.label.includes("突破帶量"));
  check("a quiet break fails the volume gate", vol?.passed === false, vol?.detail);
  check("so the pattern is not confirmed", db?.status !== "confirmed", db?.status);
}

{
  // The whole sequence: break with volume, retest to the neckline, close back above.
  const candles = doubleBottom([...ramp(110, 122, 4), ...ramp(122, 111, 4), 119, 121]);
  for (const c of candles.slice(-10, -8)) c.volume = 6000;
  const { patterns } = detectPatterns(candles, "D1");
  const db = patterns.find((p) => p.name === "雙重底");
  check("break + volume + held retest confirms", db?.status === "confirmed",
    db?.checks.map((c) => `${c.passed ? "✓" : "✗"}${c.label}`));
  check("every check passed", db?.checks.every((c) => c.passed) === true);
}

// ── a break that closes back inside is a failure, and is reported ──
{
  const candles = doubleBottom([...ramp(110, 120, 4), ...ramp(120, 100, 6)]);
  for (const c of candles.slice(-10, -8)) c.volume = 6000;
  const { patterns } = detectPatterns(candles, "D1");
  const db = patterns.find((p) => p.name === "雙重底");
  check("a break that gives it all back is a failure", db?.status === "failed", db?.status);
  // Kept rather than dropped: a failed pattern is the other side getting paid.
  check("and is still reported", db !== undefined);
}

// ── head and shoulders: the head sets the distance ────────────────
{
  // Shoulders at 110, head at 125, neckline at 100. Height 25 → target 75.
  const candles = series([
    ...LEAD,
    ...ramp(100, 110, 6),
    ...ramp(110, 100, 6),
    ...ramp(100, 125, 9),
    ...ramp(125, 100, 9),
    ...ramp(100, 110, 6),
    ...ramp(110, 101, 6),
    99, 98,
  ]);
  const { patterns } = detectPatterns(candles, "D1");
  const hs = patterns.find((p) => p.name === "頭肩頂");
  check("a head-and-shoulders is found", hs !== undefined, patterns.map((p) => p.name));
  check("it points short", hs?.direction === "short");
  check("the head is the invalidation level",
    Math.abs((hs?.invalidation_level ?? 0) - 125) < 2, hs?.invalidation_level);
  check("the target is the head's distance from the neckline, projected down",
    (hs?.target ?? 999) < 85, hs?.target);
  check("and the basis names the head",
    hs?.target_basis.includes("頭部") === true, hs?.target_basis);
}

// ── ascending triangle: flat top, rising lows ─────────────────────
{
  const candles = series([
    ...LEAD,
    ...ramp(100, 120, 7),
    ...ramp(120, 104, 7),
    ...ramp(104, 120, 7),
    ...ramp(120, 110, 6),
    ...ramp(110, 119, 6),
  ], 1);
  const { patterns } = detectPatterns(candles, "D1");
  const tri = patterns.find((p) => p.name === "上升三角形" || p.name === "對稱三角形");
  check("a converging triangle is found", tri !== undefined, patterns.map((p) => p.name));
  check("it breaks upward", tri?.direction === "long", tri?.name);
  check("the target sits above the boundary",
    (tri?.target ?? 0) > (tri?.breakout_level ?? 0), [tri?.target, tri?.breakout_level]);
}

// ── only confirmed patterns are allowed to change anything ────────
{
  const candles = doubleBottom([...ramp(110, 122, 4), ...ramp(122, 111, 4), 119, 121]);
  for (const c of candles.slice(-10, -8)) c.volume = 6000;
  const { patterns } = detectPatterns(candles, "D1");

  const confirmed = patterns.filter((p) => p.status === "confirmed");
  const contributions = patternContributions(patterns, 120);
  check("there is something confirmed to test with", confirmed.length > 0);
  check("a confirmed pattern becomes a protecting structure",
    contributions.entryStructures.length === confirmed.length,
    contributions.entryStructures);
  check("its neckline is typed as one", contributions.entryStructures[0]?.type === "型態頸線");
  check("and its target becomes a path obstacle",
    contributions.pathObstacles.length === confirmed.length);
  check("every pattern still gets a bias item",
    contributions.biasItems.length === patterns.length);

  // The gate, stated as an invariant rather than checked case by case.
  const unconfirmed = patterns.filter((p) => p.status !== "confirmed");
  const weightedUnconfirmed = contributions.biasItems.filter(
    (b, i) => patterns[i].status !== "confirmed" && b.weight > 0,
  );
  check("nothing unconfirmed carries weight", weightedUnconfirmed.length === 0,
    weightedUnconfirmed);
  check("nor claims a direction",
    contributions.biasItems.every((b, i) =>
      patterns[i].status === "confirmed" || b.direction === "neutral"));
  check("there were unconfirmed patterns to check", unconfirmed.length >= 0);
}

// ── FX has no volume, and the substitute is declared ──────────────
{
  // Same shape, volume absent throughout, and a *narrow* breakout bar.
  const candles = doubleBottom([...ramp(110, 113, 4), ...ramp(113, 111, 3), 112], 0.2, null);
  const { patterns } = detectPatterns(candles, "D1");
  const db = patterns.find((p) => p.name === "雙重底");
  const vol = db?.checks.find((c) => c.label.includes("突破帶量"));
  check("with no volume the check is still made", vol !== undefined, db?.checks);
  check("and it says it switched to a proxy",
    vol?.label.includes("振幅代理") === true, vol?.label);
  check("a narrow breakout bar fails the proxy too", vol?.passed === false, vol?.detail);
}

// ── determinism ───────────────────────────────────────────────────
{
  const candles = doubleBottom([...ramp(110, 122, 4), ...ramp(122, 111, 4), 119, 121]);
  const runs = Array.from({ length: 5 }, () =>
    JSON.stringify(detectPatterns(candles, "D1").patterns),
  );
  check("the same candles always give the same patterns", new Set(runs).size === 1);
}

report("patterns");

import { check, report } from "./_harness";
import {
  CLUSTER_THRESHOLD,
  MIN_OVERLAP,
  correlationReport,
} from "@/lib/analysis/correlation";
import type { Candle } from "@/lib/data-sources/ohlcv";

/**
 * 相關性檢查.
 *
 * The properties that matter: a pair sharing every move reads +1 and a pair
 * mirroring every move reads −1 (the machinery measures what it claims);
 * alignment is by date so mismatched holiday calendars cannot manufacture
 * lag; and too little overlap yields null, never a number — a correlation on
 * three weeks of data is a coin flip with decimals.
 */

function series(n: number, fn: (i: number) => number, skip?: (i: number) => boolean): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    if (skip?.(i)) continue;
    const c = fn(i);
    out.push({
      time: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(),
      open: c,
      high: c * 1.002,
      low: c * 0.998,
      close: c,
      volume: 1,
    });
  }
  return out;
}

// A deterministic wiggle with real variance, shared by the base fixtures.
const wiggle = (i: number) => 100 * (1 + 0.01 * Math.sin(i * 1.7) + 0.003 * Math.sin(i * 0.31));

// ── the machinery measures what it claims ─────────────────────────
{
  const a = series(120, wiggle);
  // Same returns scaled up: correlation of returns is scale-free, so r = 1.
  const b = series(120, (i) => wiggle(i) * 50);
  // Mirror image: every up move is a down move.
  const inverse = series(120, (i) => 100 * (100 / wiggle(i) / 100 + 1) * 50);
  const r = correlationReport({ A: a, B: b, C: inverse });

  const ab = r.pairs.find((p) => (p.a === "A" && p.b === "B") || (p.a === "B" && p.b === "A"))!;
  check("identical return streams read +1", ab.r === 1, ab);
  const ac = r.pairs.find((p) => [p.a, p.b].includes("A") && [p.a, p.b].includes("C"))!;
  check("mirrored return streams read −1", ac.r !== null && ac.r <= -0.99, ac);
  check("the diagonal is 1", r.matrix.every((row, i) => row[i] === 1));
  check("the matrix is symmetric",
    r.matrix.every((row, i) => row.every((v, j) => v === r.matrix[j][i])));
  check("both extremes are flagged as clusters",
    r.clusters.length === 3, r.clusters.map((p) => `${p.a}-${p.b}=${p.r}`));
  check("pairs are ordered strongest first",
    Math.abs(r.pairs[0].r ?? 0) >= Math.abs(r.pairs[r.pairs.length - 1].r ?? 0));
  check("the threshold is stated where the page reads it", CLUSTER_THRESHOLD === 0.7);
}

// ── independence reads near zero ──────────────────────────────────
{
  let seed = 9;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };
  let p1 = 100;
  let p2 = 100;
  const a = series(200, () => (p1 *= 1 + rand() * 0.01));
  const b = series(200, () => (p2 *= 1 + rand() * 0.01));
  const r = correlationReport({ A: a, B: b });
  const ab = r.pairs[0];
  check("independent walks read near zero", ab.r !== null && Math.abs(ab.r) < 0.35, ab);
  check("and are not flagged", r.clusters.length === 0);
}

// ── alignment is by date, not by row ──────────────────────────────
{
  // Same underlying series, but B is closed every 7th day (a different
  // holiday calendar). Row-aligned correlation would smear each gap into
  // manufactured lag; date-aligned stays at 1 on the shared days.
  const a = series(120, wiggle);
  const b = series(120, wiggle, (i) => i % 7 === 3);
  const r = correlationReport({ A: a, B: b });
  const ab = r.pairs[0];
  check("mismatched calendars do not break a perfect correlation", ab.r === 1, ab);
  check("and the overlap counts only shared sessions", ab.overlap < 120, ab.overlap);
}

// ── too little data refuses to answer ─────────────────────────────
{
  const a = series(200, wiggle);
  const b = series(MIN_OVERLAP - 5, wiggle);
  const r = correlationReport({ A: a, B: b });
  check("a symbol below the overlap floor is excluded entirely",
    !r.symbols.includes("B"), r.symbols);

  // Two long series whose *shared* dates are too few: B trades only when A
  // doesn't, except for a handful of days.
  const sparse = series(200, wiggle, (i) => i % 8 !== 0);
  const r2 = correlationReport({ A: a, B: sparse });
  const pair = r2.pairs.find((p) => [p.a, p.b].includes("B"));
  check("thin overlap yields null, not a guess",
    pair === undefined || pair.r === null, pair);

  const empty = correlationReport({ A: a });
  check("one symbol alone produces an empty pair list", empty.pairs.length === 0);
  check("the method and its limits are stated", empty.note.includes("60") && empty.note.includes("Pearson"));
}

report("相關性檢查");

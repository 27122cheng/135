import { check, report } from "./_harness";
import { CONDITIONS, FAMILIES, buildContext } from "@/lib/analysis/lab-conditions";
import type { Candle } from "@/lib/data-sources/ohlcv";

/**
 * 進場條件庫.
 *
 * The single property everything else rests on is **no look-ahead**: a
 * condition read at bar i must give the same answer whether or not bars after
 * i exist. Get that wrong and every hit rate in the lab becomes a measurement
 * of the peeking rather than of the market — and it is an easy thing to get
 * wrong, because swings, gaps and order blocks are all defined by what came
 * after them.
 *
 * The individual behaviours below are checked on hand-built bars where the
 * right answer is obvious by construction.
 */

function bar(o: number, h: number, l: number, c: number, day: number, volume = 1000): Candle {
  return { time: new Date(Date.UTC(2020, 0, 1 + day)).toISOString(), open: o, high: h, low: l, close: c, volume };
}

function series(n: number, fn: (i: number) => number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const p = fn(i);
    return bar(p, p * 1.008, p * 0.992, p, i, 1000 + (i % 7) * 200);
  });
}

// ── the library is well-formed ────────────────────────────────────
{
  check("every condition has a distinct id",
    new Set(CONDITIONS.map((c) => c.id)).size === CONDITIONS.length);
  check("every condition states a family the page knows",
    CONDITIONS.every((c) => (FAMILIES as readonly string[]).includes(c.family)),
    CONDITIONS.filter((c) => !(FAMILIES as readonly string[]).includes(c.family)).map((c) => c.id));
  check("every family is actually used",
    FAMILIES.every((f) => CONDITIONS.some((c) => c.family === f)),
    FAMILIES.filter((f) => !CONDITIONS.some((c) => c.family === f)));
  check("the requested schools are all represented",
    ["SMC/ICT", "CRT", "裸K", "量能"].every((f) => CONDITIONS.some((c) => c.family === f)));
}

// ── no look-ahead ─────────────────────────────────────────────────
//
// The test that makes the rest meaningful: truncate the series at bar i and
// every condition must answer exactly as it did with the full history behind
// it. A swing read before it was confirmable, an order block dated by a break
// that has not happened yet, a "still unfilled" gap that a later bar filled —
// all of them fail here.
{
  let seed = 11;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };
  let price = 1800;
  const full: Candle[] = [];
  for (let i = 0; i < 260; i++) {
    price *= 1 + rand() * 0.02;
    const h = price * (1 + Math.abs(rand()) * 0.012);
    const l = price * (1 - Math.abs(rand()) * 0.012);
    full.push(bar(price * (1 + rand() * 0.004), Math.max(h, price), Math.min(l, price), price, i, 900 + Math.abs(rand()) * 3000));
  }

  const ctxFull = buildContext(full);
  const mismatches: string[] = [];
  for (const at of [120, 175, 210, 259]) {
    const ctxCut = buildContext(full.slice(0, at + 1));
    for (const c of CONDITIONS) {
      for (const d of ["long", "short"] as const) {
        const withFuture = c.test(ctxFull, at, d);
        const withoutFuture = c.test(ctxCut, at, d);
        if (withFuture !== withoutFuture) mismatches.push(`${c.id}@${at}/${d}`);
      }
    }
  }
  check("no condition changes its answer when the future is removed",
    mismatches.length === 0, mismatches);
}

// ── nothing throws, anywhere ──────────────────────────────────────
{
  const ctx = buildContext(series(300, (i) => 100 + i * 0.3));
  let threw: string | null = null;
  for (const c of CONDITIONS) {
    for (const i of [0, 1, 2, 5, 30, 60, 150, 299]) {
      for (const d of ["long", "short"] as const) {
        try {
          c.test(ctx, i, d);
        } catch (err) {
          threw = `${c.id}@${i}/${d}: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }
  }
  check("no condition throws at the edges or during warm-up", threw === null, threw);
}

const idOf = (id: string) => CONDITIONS.find((c) => c.id === id)!;

// ── SMC: BOS, CHoCH, order block, FVG, sweep ──────────────────────
{
  // A rising *staircase*, not a straight line: a swing high needs an actual
  // local peak, so a monotonic series legitimately has none and never breaks
  // structure. The oscillation is what makes pivots exist to be broken.
  const up = series(120, (i) => 100 + i + Math.sin(i / 3) * 4);
  const ctx = buildContext(up);
  check("a rising series produces up breaks of structure",
    ctx.bosUp.filter(Boolean).length > 5, ctx.bosUp.filter(Boolean).length);
  check("and no down breaks", ctx.bosDown.filter(Boolean).length === 0);

  // A swing is only known two bars after it printed.
  const spike = [
    ...series(20, () => 100),
    bar(100, 120, 99, 118, 20),
    ...Array.from({ length: 6 }, (_, k) => bar(110, 112, 105, 108, 21 + k)),
  ];
  const spikeCtx = buildContext(spike);
  check("a swing high is not visible on the bar that made it",
    !Number.isFinite(spikeCtx.swingHigh[20]) || spikeCtx.swingHigh[20] < 120, spikeCtx.swingHigh[20]);
  check("but is once two bars have confirmed it",
    spikeCtx.swingHigh[22] === 120, spikeCtx.swingHigh[22]);

  // FVG: bar 2's low above bar 0's high leaves a window.
  const gap = [
    bar(100, 101, 99, 100, 0),
    bar(101, 108, 100, 107, 1),
    bar(107, 112, 103, 110, 2),
    bar(110, 111, 102, 102, 3), // trades back down into the 101–103 window
  ];
  const gapCtx = buildContext(gap);
  check("a bullish fair value gap is found", gapCtx.fvgUpLow[2] === 101 && gapCtx.fvgUpHigh[2] === 103,
    { low: gapCtx.fvgUpLow[2], high: gapCtx.fvgUpHigh[2] });
  check("and price inside it satisfies fvg-inside",
    idOf("fvg-inside").test(gapCtx, 3, "long"), gapCtx.close[3]);

  // Liquidity sweep: takes out ten bars of lows and closes back above.
  const sweep = [
    ...Array.from({ length: 12 }, (_, k) => bar(100, 102, 98, 100, k)),
    bar(100, 101, 94, 100, 12),
  ];
  const sweepCtx = buildContext(sweep);
  check("a stop hunt below the lows that closes back up is a sweep",
    idOf("liquidity-sweep").test(sweepCtx, 12, "long"));
  check("and is not a short sweep", !idOf("liquidity-sweep").test(sweepCtx, 12, "short"));
}

// ── CRT ───────────────────────────────────────────────────────────
{
  const crt = [
    bar(100, 110, 90, 105, 0), // candle 1: the range
    bar(105, 106, 88, 95, 1), // candle 2: sweeps the low, closes back inside
    bar(95, 108, 94, 106, 2), // candle 3: expands above the midpoint (100)
  ];
  const ctx = buildContext(crt);
  check("the three-candle CRT model is recognised", idOf("crt").test(ctx, 2, "long"));
  check("and not in the opposite direction", !idOf("crt").test(ctx, 2, "short"));

  // Candle 2 must close back inside the range — a close below it is a real
  // break, not a manipulation leg.
  const broken = [crt[0], bar(105, 106, 88, 89, 1), crt[2]];
  check("a candle 2 that closes outside the range is not CRT",
    !idOf("crt").test(buildContext(broken), 2, "long"));
}

// ── naked price action ────────────────────────────────────────────
{
  const engulf = [bar(100, 101, 97, 98, 0), bar(97, 103, 96, 102, 1)];
  check("a bullish engulfing is recognised",
    idOf("engulfing").test(buildContext(engulf), 1, "long"));
  check("and is not read as bearish",
    !idOf("engulfing").test(buildContext(engulf), 1, "short"));

  const hammer = [bar(100, 100, 100, 100, 0), bar(100, 101, 90, 99.5, 1)];
  check("a hammer is a long pin bar",
    idOf("pin-bar").test(buildContext(hammer), 1, "long"));
  check("and not a short one",
    !idOf("pin-bar").test(buildContext(hammer), 1, "short"));

  const insideBreak = [
    bar(100, 110, 90, 100, 0),
    bar(100, 105, 95, 100, 1),
    bar(100, 108, 99, 107, 2),
  ];
  check("an inside bar followed by a break up qualifies",
    idOf("inside-break").test(buildContext(insideBreak), 2, "long"));
}

// ── volume proxies stay honest where there is no volume ───────────
{
  // Spot FX: the feed reports nothing. Every volume condition must be false
  // rather than treating "unknown" as "average".
  const noVolume = Array.from({ length: 60 }, (_, i) => ({
    ...bar(100, 102, 98, 101, i),
    volume: null,
  }));
  const ctx = buildContext(noVolume);
  const volumeConditions = CONDITIONS.filter((c) => c.family === "量能" && c.id !== "close-strength");
  check("volume conditions are never satisfied without volume data",
    volumeConditions.every((c) => !c.test(ctx, 59, "long") && !c.test(ctx, 59, "short")),
    volumeConditions.filter((c) => c.test(ctx, 59, "long")).map((c) => c.id));
  check("but the close-position proxy still works — it needs no volume",
    idOf("close-strength").test(ctx, 59, "long"));

  // A genuine volume spike is picked up where volume exists.
  const spiky = [
    ...Array.from({ length: 40 }, (_, i) => bar(100, 102, 98, 100, i, 1000)),
    bar(100, 106, 99, 105, 40, 5000),
  ];
  check("a volume climax is recognised where the feed reports volume",
    idOf("volume-climax").test(buildContext(spiky), 40, "long"));
}

// ── position conditions ───────────────────────────────────────────
{
  const ranged = Array.from({ length: 40 }, (_, i) =>
    bar(100, 110, 90, i === 39 ? 92 : 100, i));
  const ctx = buildContext(ranged);
  check("a close near the bottom of the range is a discount for longs",
    idOf("discount").test(ctx, 39, "long"), ctx.rangePos[39]);
  check("and not for shorts", !idOf("discount").test(ctx, 39, "short"));

  const wk = buildContext(series(40, (i) => 100 + i));
  check("the week open is carried across the week's bars",
    wk.weekOpen.slice(10, 20).every((v) => Number.isFinite(v)));
  check("and rising price sits above it", idOf("week-open-side").test(wk, 39, "long"));
}

// ── ICT 入場模型：OTE / IDM / IFVG / 趨勢線 / MSS＋位移 ──────────────
//
// The models the operator brought (HTF POI + MSS + IDM + FVG + OTE, the
// IFVG model, the two-touch trendline break). Each is a real condition on
// real candles, forward-tested like every other, and adopted into the score
// only after verification — never a gate on its own.
{
  // OTE: an up-leg from a confirmed low (idx 3) to a confirmed high (idx 9),
  // then a pullback whose close sits at 70% of the leg.
  const lows =  [100, 97, 94, 90, 93, 96, 99, 102, 105, 108, 106, 103, 100, 97.6];
  const highs = [103, 100, 97, 93, 96, 99, 102, 105, 108, 111, 109, 106, 103, 100];
  const ote = lows.map((l, i) => bar(l + 1, highs[i], l, i === 13 ? 97.4 + 0 : l + 2, i));
  // leg: low 90 → high 111, range 21; 70% retrace from the high = 111 − 14.7 = 96.3.
  ote[13] = bar(99, 100, 96, 96.3, 13);
  const oteCtx = buildContext(ote);
  check("a 70% pullback of the last up-leg is inside OTE", idOf("ote").test(oteCtx, 13, "long"));
  check("and not a short OTE — the leg was up", !idOf("ote").test(oteCtx, 13, "short"));
  const shallow = [...ote]; shallow[13] = bar(104, 105, 103, 104, 13); // 33% — too shallow
  check("a shallow pullback is not OTE", !idOf("ote").test(buildContext(shallow), 13, "long"));

  // IDM: structural low 90 at idx 3 (confirmed), lows then rise so no new
  // pivot forms; the lowest of the five bars before the entry (93) is the
  // inducement; the entry bar sweeps it and closes back above, structure intact.
  const idmLows = [98, 95, 92, 90, 91, 92, 93, 94, 95, 96, 96, 92.5];
  const idm = idmLows.map((l, i) => bar(l + 1, l + 3, l, i === 11 ? 94 : l + 2, i));
  const idmCtx = buildContext(idm);
  check("sweeping the inducement while the structural low holds is IDM",
    idOf("idm-sweep").test(idmCtx, 11, "long"));
  const through = [...idm]; through[11] = bar(93.5, 94, 89, 89.5, 11); // through the structure
  check("breaking the structural low is not IDM — that is a failed structure",
    !idOf("idm-sweep").test(buildContext(through), 11, "long"));

  // IFVG: a bearish gap (bar 2's high under bar 0's low) that price then CLOSES
  // above becomes support; a return into it is the long entry.
  const ifvg = [
    bar(101, 103, 100, 102, 0),
    bar(100, 101, 97, 98, 1),
    bar(96, 95, 92, 93, 2), // high 95 < bar 0 low 100 → bearish FVG 95–100
    bar(94, 103, 93, 102, 3), // closes above 100 → the gap inverts to support
    bar(101, 101.5, 97, 98, 4), // returns into 95–100
  ];
  const ifvgCtx = buildContext(ifvg);
  check("a bearish gap closed above and retested is an IFVG long",
    idOf("ifvg").test(ifvgCtx, 4, "long"));
  check("before the inversion the same zone is not an IFVG",
    !idOf("ifvg").test(ifvgCtx, 2, "long"));
  check("it is not an IFVG short", !idOf("ifvg").test(ifvgCtx, 4, "short"));

  // Trendline break: rising swing lows at idx 2 (90) and idx 8 (94); the line
  // at idx 12 is ≈96.67. Bar 11 closes above it, bar 12 closes below → short.
  const tlLows = [95, 92, 90, 92, 95, 97, 96, 95, 94, 95, 97, 97, 94.5];
  const tl = tlLows.map((l, i) => bar(l + 1, l + 3, l, i === 12 ? 95 : l + 2, i));
  const tlCtx = buildContext(tl);
  check("a close through the two-touch up-trendline is a break (short)",
    idOf("trendline-break").test(tlCtx, 12, "short"));
  check("the bar before the break is not one", !idOf("trendline-break").test(tlCtx, 11, "short"));
  check("an up-trendline break is not a long", !idOf("trendline-break").test(tlCtx, 12, "long"));

  // MSS + displacement is a strict subset of CHoCH: every hit is a CHoCH, and
  // a CHoCH with a small body is refused.
  // Two frequencies, no drift: the slow wave moves the troughs and peaks
  // both ways, so structure breaks in both directions and flips — a single
  // drifting sine never breaks a prior trough and never produces a CHoCH.
  const wave = series(300, (i) => 100 + 6 * Math.sin(i / 5) + 5 * Math.sin(i / 23));
  const wCtx = buildContext(wave);
  let choch = 0, mss = 0, subset = true;
  for (let i = 0; i < wave.length; i++) {
    for (const d of ["long", "short"] as const) {
      const a = idOf("choch").test(wCtx, i, d);
      const b = idOf("mss-displacement").test(wCtx, i, d);
      if (a) choch++;
      if (b) mss++;
      if (b && !a) subset = false;
    }
  }
  check("the wave produces CHoCHs to test against", choch > 0, choch);
  check("MSS+displacement only ever fires on a CHoCH", subset);
  check("and is stricter than CHoCH", mss < choch, [mss, choch]);

  // The new context fields never throw across warm-up and edges.
  for (const id of ["ote", "idm-sweep", "ifvg", "trendline-break", "mss-displacement"]) {
    let threw = false;
    try {
      for (let i = 0; i < 25; i++) { idOf(id).test(buildContext(wave.slice(0, i + 1)), i, "long"); }
    } catch { threw = true; }
    check(`${id} is safe during warm-up`, !threw);
  }
}

report("進場條件庫");

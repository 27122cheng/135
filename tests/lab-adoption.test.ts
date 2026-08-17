import { check, report } from "./_harness";
import {
  adoptionFromFinding,
  evaluateAdoption,
  findAdoption,
  parseAdoptions,
  removeAdoption,
  serializeAdoptions,
  upsertAdoption,
  type LabAdoption,
} from "@/lib/analysis/lab-adoption";
import { CONDITIONS, WARMUP, runLab } from "@/lib/analysis/lab";
import type { Candle } from "@/lib/data-sources/ohlcv";
import type { LabFinding } from "@/lib/analysis/lab";

/**
 * 採用 — the door between the lab and live trading.
 *
 * The properties worth pinning are all about what cannot happen: an unverified
 * combination cannot become a gate, a gate cannot pass when it could not be
 * evaluated, a stored record referring to a condition this build no longer
 * defines is dropped rather than half-honoured, and nothing here can make a
 * trade happen that would not otherwise have happened.
 */

function bars(fn: (i: number) => number, n: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const c = fn(i);
    out.push({
      time: new Date(Date.UTC(2020, 0, 1 + i)).toISOString(),
      open: c,
      high: c * 1.006,
      low: c * 0.994,
      close: c,
      volume: 1000,
    });
  }
  return out;
}

const adoption = (over: Partial<LabAdoption> = {}): LabAdoption => ({
  symbol: "XAUUSD",
  direction: "long",
  ids: ["ema50-side"],
  labels: ["站在 EMA50 正確側"],
  inSample: { trades: 120, hitRate: 0.83 },
  outOfSample: { trades: 51, hitRate: 0.81 },
  floor: 0.8,
  bars: 400,
  adoptedAt: "2026-08-17T00:00:00.000Z",
  ...over,
});

// ── only a verified finding may be adopted ────────────────────────
{
  const base: LabFinding = {
    ids: ["ema50-side"],
    labels: ["站在 EMA50 正確側"],
    inSample: { trades: 120, wins: 100, hitRate: 0.83, expectancyR: 0.5, entries: 180, unresolved: 60 },
    outOfSample: { trades: 51, wins: 41, hitRate: 0.81, expectancyR: 0.5, entries: 74, unresolved: 23 },
    verified: false,
    lift: 12,
  };

  let threw = false;
  try {
    adoptionFromFinding("XAUUSD", "long", base, 0.8, 400);
  } catch {
    threw = true;
  }
  check("an unverified finding cannot be adopted", threw);

  const ok = adoptionFromFinding("XAUUSD", "long", { ...base, verified: true }, 0.8, 400);
  check("a verified one can", ok.ids.join("+") === "ema50-side");
  check("and the stored numbers are the measured ones",
    ok.inSample.trades === 120 && ok.outOfSample.hitRate === 0.81, ok);

  // A finding whose hit rates are null (no resolved trades) must not slip past
  // on `verified` alone — the adoption record would carry nothing to show.
  let threwNull = false;
  try {
    adoptionFromFinding("XAUUSD", "long", {
      ...base,
      verified: true,
      inSample: { trades: 0, wins: 0, hitRate: null, expectancyR: null, entries: 0, unresolved: 0 },
    }, 0.8, 400);
  } catch {
    threwNull = true;
  }
  check("a finding without hit rates cannot be adopted", threwNull);
}

// ── the store round-trips, and rejects what it can't honour ───────
{
  const one = adoption();
  const two = adoption({ symbol: "EURUSD", direction: "short", ids: ["rsi-side"] });
  const list = upsertAdoption(upsertAdoption([], one), two);
  const back = parseAdoptions(serializeAdoptions(list));
  check("adoptions survive a round trip", back.length === 2, back.map((a) => a.symbol));
  check("and are found by symbol and direction",
    findAdoption(back, "EURUSD", "short")?.ids[0] === "rsi-side");
  check("a direction that was never adopted is not found",
    findAdoption(back, "EURUSD", "long") === null);

  // One per symbol+direction: adopting again replaces rather than stacks.
  const replaced = upsertAdoption(list, adoption({ ids: ["rsi-side"] }));
  check("adopting again replaces the same symbol and direction", replaced.length === 2);
  check("with the newer combination",
    findAdoption(replaced, "XAUUSD", "long")?.ids[0] === "rsi-side");

  check("撤銷 removes exactly one", removeAdoption(replaced, "XAUUSD", "long").length === 1);
  check("and leaves the others alone",
    findAdoption(removeAdoption(replaced, "XAUUSD", "long"), "EURUSD", "short") !== null);
}

// ── malformed or obsolete records are dropped whole ───────────────
{
  check("garbage parses to nothing", parseAdoptions("not json").length === 0);
  check("a non-array parses to nothing", parseAdoptions('{"symbol":"XAUUSD"}').length === 0);
  check("null parses to nothing", parseAdoptions(null).length === 0);

  // The case that matters: a deploy removes a condition, and a stored gate
  // refers to it. Honouring the half it still understands would silently
  // loosen a requirement nobody asked to loosen.
  const stale = JSON.stringify([{ ...adoption(), ids: ["ema50-side", "condition-that-no-longer-exists"] }]);
  check("a record naming an unknown condition is dropped entirely",
    parseAdoptions(stale).length === 0);

  const dupes = JSON.stringify([{ ...adoption(), ids: ["ema50-side", "ema50-side"] }]);
  check("a record repeating a condition is dropped", parseAdoptions(dupes).length === 0);

  const noStats = JSON.stringify([{ ...adoption(), inSample: null }]);
  check("a record without measurements is dropped", parseAdoptions(noStats).length === 0);

  // Labels are re-derived from the condition list, never trusted from storage —
  // otherwise the card can show one thing while the gate tests another.
  const lying = JSON.stringify([{ ...adoption(), labels: ["完全不相干的說明"] }]);
  check("labels are re-derived from the condition ids",
    parseAdoptions(lying)[0]?.labels[0] === CONDITIONS.find((c) => c.id === "ema50-side")!.label,
    parseAdoptions(lying)[0]?.labels);
}

// ── the live gate measures what it says it measures ───────────────
{
  const up = bars((i) => 100 * 1.004 ** i, 300);
  const down = bars((i) => 300 * 0.996 ** i, 300);

  const long = evaluateAdoption(adoption(), up);
  check("a long EMA50 condition holds in an uptrend", long.met, long.checks);
  check("and every check is reported individually",
    long.checks.length === 1 && long.checks[0].id === "ema50-side");
  check("an evaluated gate is not marked unevaluable", long.unevaluable === null);

  const failing = evaluateAdoption(adoption(), down);
  check("and fails in a downtrend", !failing.met, failing.checks);

  // Every condition must hold — a stack is an AND, not a vote.
  const stacked = evaluateAdoption(
    adoption({ ids: ["ema50-side", "higher-structure"], labels: ["", ""] }),
    down,
  );
  check("a stacked gate needs all of its conditions", !stacked.met, stacked.checks);
  check("and reports each one separately", stacked.checks.length === 2);

  // The provenance travels with the gate so the card can show it.
  check("the gate carries the numbers it was adopted on",
    long.in_sample_trades === 120 && long.out_of_sample_trades === 51, long);
  check("and is not marked as blocking until the builder says so", long.blocked === false);
}

// ── unevaluable is never a pass ───────────────────────────────────
{
  const short = evaluateAdoption(adoption(), bars((i) => 100 + i, WARMUP));
  check("too few candles means not met", !short.met);
  check("and says why rather than going quiet",
    short.unevaluable !== null && short.unevaluable.includes(String(WARMUP + 1)), short.unevaluable);
  check("missing candles altogether means not met", !evaluateAdoption(adoption(), undefined).met);
  check("no checks are invented when nothing could be checked",
    evaluateAdoption(adoption(), undefined).checks.length === 0);
}

// ── end to end: what the lab verifies is what the gate tests ──────
//
// A relentless uptrend is the one series where a long condition genuinely
// clears the floor, so it is the only place this round trip can be exercised
// without inventing a fake finding. The point is the identity: the ids the lab
// reports as verified are the ids the live gate evaluates, with no translation
// step in between where the two could drift apart.
{
  const meta = { symbol: "XAUUSD", category: "metal" as const };
  const rising = bars((i) => 100 * 1.004 ** i, 400);
  const r = runLab(meta, rising, "long")!;
  const verified = r.verified[0];
  check("the uptrend verifies at least one condition", verified !== undefined,
    r.verified.map((f) => f.ids));
  if (verified) {
    const a = adoptionFromFinding(meta.symbol, "long", verified, r.floor, r.bars);
    const gate = evaluateAdoption(a, rising);
    check("the adopted ids are exactly the verified ids",
      gate.ids.join("+") === verified.ids.join("+"), { gate: gate.ids, verified: verified.ids });
    check("and the gate holds on the same data that verified it", gate.met, gate.checks);
  }
}

report("實驗室採用");

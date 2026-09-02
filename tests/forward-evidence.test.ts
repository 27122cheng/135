import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, report } from "./_harness";
import {
  FORWARD_MIN_RESOLVED,
  FORWARD_OPPOSE_CAP,
  FORWARD_SUPPORT_CAP,
  forwardEvidence,
  forwardEvidenceDelta,
} from "@/lib/analysis/forward-evidence";
import { buildContext } from "@/lib/analysis/lab-conditions";
import type { ForwardStat } from "@/lib/analysis/lab-forward";
import type { Candle } from "@/lib/data-sources/ohlcv";

/**
 * 前進驗證證據 — the lab's scoreboard, read at signal time and priced into
 * confidence. Bounded, direction-aware, and only for conditions with enough
 * resolved trades to mean anything.
 */

function series(n: number, fn: (i: number) => number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const c = fn(i);
    return { time: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1000 };
  });
}
const stat = (over: Partial<ForwardStat>): ForwardStat => ({
  conditionId: "ema50-side", label: "EMA50 同側", direction: "long",
  open: 0, wins: 15, losses: 10, scratches: 0, expired: 0, resolved: 25,
  hitRate: 0.6, expectancyR: 0.3, taken: 25, ...over,
});

// A steadily rising series: every trend-side condition fires long on the
// last bar and none fires short.
const up = series(200, (i) => 100 + i * 0.4);
const bar = up.length - 1;
const ctx = buildContext(up, [bar]);
const at = { ctx, bar, barTime: up[bar].time };

// ── what counts as evidence ───────────────────────────────────────
{
  const ev = forwardEvidence({ direction: "long", stats: [stat({})], ...at });
  check("a verified condition firing in the signal's direction supports it",
    ev.supporting.length === 1 && ev.opposing.length === 0, ev);
  check("and it carries its own record", ev.supporting[0].resolved === 25 && ev.supporting[0].expectancyR === 0.3);

  const thin = forwardEvidence({ direction: "long", stats: [stat({ resolved: FORWARD_MIN_RESOLVED - 1 })], ...at });
  check("below the sample floor a record is noise, not evidence", thin.supporting.length === 0 && thin.verifiedCount === 0);

  const losing = forwardEvidence({ direction: "long", stats: [stat({ expectancyR: -0.1 })], ...at });
  check("a losing record is not evidence for anything", losing.supporting.length === 0 && losing.verifiedCount === 0);

  // A verified SHORT record for a condition that fires short would oppose a
  // long. On a rising series nothing fires short, so it is verified but silent.
  const shortRec = forwardEvidence({ direction: "long", stats: [stat({ direction: "short" })], ...at });
  check("a verified opposite-direction record that is not firing opposes nothing",
    shortRec.opposing.length === 0 && shortRec.verifiedCount === 1, shortRec);
  // And the same record read for a short signal is support only if it fires.
  const asShort = forwardEvidence({ direction: "short", stats: [stat({ direction: "short" })], ...at });
  check("direction is read from the record, then checked against the bar",
    asShort.supporting.length === 0, asShort);

  const unknown = forwardEvidence({ direction: "long", stats: [stat({ conditionId: "no-such-condition" })], ...at });
  check("a record for a condition that no longer exists is ignored, not thrown on",
    unknown.supporting.length === 0);
}

// ── what it may do to the score ───────────────────────────────────
{
  const many = (n: number, direction: "long" | "short") =>
    Array.from({ length: n }, (_, k) => ({ id: `c${k}`, label: `條件 ${k}`, direction, resolved: 30, hitRate: 0.6, expectancyR: 0.4 }));
  const base = { verifiedCount: 0, barTime: at.barTime };

  check("nothing firing moves nothing",
    forwardEvidenceDelta({ ...base, supporting: [], opposing: [] }).delta === 0 &&
      forwardEvidenceDelta(null).factor === null);
  check("two supporting conditions are +4",
    forwardEvidenceDelta({ ...base, supporting: many(2, "long"), opposing: [] }).delta === 4);
  check("support is capped", forwardEvidenceDelta({ ...base, supporting: many(9, "long"), opposing: [] }).delta === FORWARD_SUPPORT_CAP);
  check("opposition is capped lower", forwardEvidenceDelta({ ...base, supporting: [], opposing: many(9, "short") }).delta === -FORWARD_OPPOSE_CAP);
  check("the caps are asymmetric on purpose", FORWARD_SUPPORT_CAP > FORWARD_OPPOSE_CAP);
  const mixed = forwardEvidenceDelta({ ...base, supporting: many(1, "long"), opposing: many(2, "short") });
  check("mixed evidence nets", mixed.delta === -2);
  check("the factor names what fired and its record",
    mixed.factor?.includes("條件 0（30 筆 +0.4R）") === true && mixed.factor.includes("反向成立"), mixed.factor);
}

// ── it is priced in confidence, before the gate, and nowhere else ──
{
  const src = readFileSync(join(__dirname, "..", "lib", "signal-builder.ts"), "utf8");
  const evidenceAt = src.indexOf("signal.forward_evidence = forwardEvidence(");
  const scoreAt = src.indexOf("signal.confidence = planConfidence(signal);");
  check("the evidence is attached before the score is computed", evidenceAt > 0 && evidenceAt < scoreAt);
  const conf = readFileSync(join(__dirname, "..", "lib", "analysis", "confidence.ts"), "utf8");
  check("confidence reads it", conf.includes("forwardEvidenceDelta(signal.forward_evidence)"));
  const scoring = readFileSync(join(__dirname, "..", "lib", "scoring.ts"), "utf8");
  const plan = readFileSync(join(__dirname, "..", "lib", "analysis", "trade-plan.ts"), "utf8");
  check("and the grade and the veto never do",
    !scoring.includes("forward_evidence") && !plan.includes("forward_evidence"));
}

report("前進驗證證據");

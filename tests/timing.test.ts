import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, report } from "./_harness";
import {
  EVENT_BLACKOUT_MS,
  analyzeTiming,
  lastBusinessDay,
  nfpTimeFor,
  upcomingHighImpactEvent,
} from "@/lib/analysis/timing";

/**
 * 時間與事件因子 — deterministic calendar effects, derived from the clock
 * with no API and no key. The invariants: NFP is the first Friday's 12:30
 * UTC; the readings never vote (weight 0); the high-impact flag rises only
 * in the pre/post window; and nothing here guesses at dates that are not
 * derivable (FOMC, CPI) — those belong to the calendar source.
 */

const at = (iso: string) => new Date(iso);

// ── NFP arithmetic ─────────────────────────────────────────────────
{
  // 2026-08-01 is a Saturday, so the first Friday is the 7th.
  const aug = nfpTimeFor(2026, 7);
  check("August 2026's NFP is Friday the 7th", aug.toISOString() === "2026-08-07T12:30:00.000Z",
    aug.toISOString());
  // 2026-05-01 is a Friday itself.
  const may = nfpTimeFor(2026, 4);
  check("a month starting on Friday uses day 1", may.getUTCDate() === 1, may.toISOString());
}

// ── the pre-release window raises the flag ─────────────────────────
{
  const before = analyzeTiming(at("2026-08-07T02:00:00Z"));
  check("inside 24h before NFP the flag rises", before.highImpactWithin24h);
  check("and the reading says when", before.items.some((i) => i.factor.includes("NFP")),
    before.items.map((i) => i.factor));

  const after = analyzeTiming(at("2026-08-07T13:30:00Z"));
  check("the first two hours after are still hot", after.highImpactWithin24h);

  const midMonth = analyzeTiming(at("2026-08-18T10:00:00Z"));
  check("an ordinary day raises nothing", !midMonth.highImpactWithin24h);
  check("readings never vote",
    midMonth.items.every((i) => i.weight === 0 && i.direction === "neutral"),
    midMonth.items);
}

// ── session windows ────────────────────────────────────────────────
{
  const overlap = analyzeTiming(at("2026-08-18T14:00:00Z"));
  check("14:00 UTC reads as the NY/Europe overlap",
    overlap.items.some((i) => i.factor.includes("紐約")), overlap.items.map((i) => i.factor));

  const thin = analyzeTiming(at("2026-08-18T21:30:00Z"));
  check("21:30 UTC reads as the thin maintenance hour",
    thin.items.some((i) => i.factor.includes("維護時段")), thin.items.map((i) => i.factor));
}

// ── weekend gap risk, Fridays only ─────────────────────────────────
{
  const lateFriday = analyzeTiming(at("2026-08-14T19:00:00Z"));
  check("late Friday warns about the weekend gap",
    lateFriday.items.some((i) => i.factor.includes("週末")), lateFriday.items.map((i) => i.factor));
  const lateThursday = analyzeTiming(at("2026-08-13T19:00:00Z"));
  check("late Thursday does not",
    !lateThursday.items.some((i) => i.factor.includes("週末")));
}

// ── FOMC (published 2026 calendar) ─────────────────────────────────
{
  // 2026-09-16 is a decision day, statement 18:00 UTC (DST).
  const dayBefore = analyzeTiming(at("2026-09-16T06:00:00Z"));
  check("12h before an FOMC decision raises the flag",
    dayBefore.highImpactWithin24h &&
      dayBefore.items.some((i) => i.factor.includes("FOMC")),
    dayBefore.items.map((i) => i.factor));
  const after = analyzeTiming(at("2026-09-16T19:30:00Z"));
  check("the press-conference window still counts",
    after.highImpactWithin24h && after.items.some((i) => i.factor.includes("剛公布")),
    after.items.map((i) => i.factor));
  const ordinary = analyzeTiming(at("2026-09-10T06:00:00Z"));
  check("an ordinary day carries no FOMC item",
    !ordinary.items.some((i) => i.factor.includes("FOMC")));
}

// ── 數據前禁入窗 ───────────────────────────────────────────────────
//
// One constant, two consumers: the builder's hard entry blackout and the
// monitor's held-position warning must describe the same window, and the
// builder must apply it after every other gate so the census attributes a
// blackout day to the event rather than to whichever gate it shadowed.
{
  check("the blackout window is two hours", EVENT_BLACKOUT_MS === 2 * 60 * 60 * 1000);
  // 2026-09-04 is the first Friday → NFP at 12:30 UTC.
  const inside = upcomingHighImpactEvent(at("2026-09-04T11:00:00Z"), EVENT_BLACKOUT_MS);
  check("90 minutes before NFP is inside the window",
    inside?.label.includes("NFP") === true && inside.minutesAway === 90, inside);
  check("just past the print, the window is over",
    upcomingHighImpactEvent(at("2026-09-04T12:31:00Z"), EVENT_BLACKOUT_MS) === null);
  check("an ordinary morning is not blacked out",
    upcomingHighImpactEvent(at("2026-09-10T09:00:00Z"), EVENT_BLACKOUT_MS) === null);

  const builder = readFileSync(join(__dirname, "..", "lib", "signal-builder.ts"), "utf8");
  check("the builder blacks out entries with the shared constant",
    builder.includes("EVENT_BLACKOUT_MS") && builder.includes("數據前禁入"));
  check("applied after the lab gate, so the withdrawal is attributable to the event",
    builder.indexOf("數據前禁入") > builder.indexOf("applyLabGate(signal"));
}

// ── month-end ──────────────────────────────────────────────────────
{
  // 2026-08-31 is a Monday.
  check("August 2026's last business day is the 31st", lastBusinessDay(2026, 7) === 31);
  // 2026-05-31 is a Sunday → the 29th (Friday).
  check("a weekend month-end walks back to Friday", lastBusinessDay(2026, 4) === 29);
  const monthEnd = analyzeTiming(at("2026-08-31T10:00:00Z"));
  check("the last business day carries the rebalancing note",
    monthEnd.items.some((i) => i.factor.includes("月底")), monthEnd.items.map((i) => i.factor));
}

report("timing factors");

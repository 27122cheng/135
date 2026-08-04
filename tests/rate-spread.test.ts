import { check, report } from "./_harness";
import {
  alignSeries,
  businessDaysBetween,
  computeRateSpread,
  weightForChange,
} from "@/lib/analysis/rate-spread";
import { rateSpreadFor, RATE_SPREADS } from "@/config/rate-spreads";
import type { YieldSeries } from "@/lib/data-sources/yields";

/**
 * 兩國利差. The rules that must not drift: no interpolation across missing
 * dates, the 20-day change drives direction and weight, and stale data is
 * refused rather than presented as current.
 */

/** Builds a weekday series ending on `end`, newest value last. */
function series(label: string, end: string, values: number[]): YieldSeries {
  const points: { date: string; value: number }[] = [];
  const cursor = new Date(`${end}T00:00:00Z`);
  for (let i = values.length - 1; i >= 0; i--) {
    while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6) {
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    points.unshift({ date: cursor.toISOString().slice(0, 10), value: values[i] });
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return { label, points, source: "stooq" };
}

// ── the weight table ──────────────────────────────────────────────
{
  check("26bp scores 2", weightForChange(26) === 2);
  check("25bp is not >25, so scores 1", weightForChange(25) === 1);
  check("10bp scores 1", weightForChange(10) === 1);
  check("9bp scores 0", weightForChange(9) === 0);
  check("the table is symmetric for falls", weightForChange(-30) === 2 && weightForChange(-9) === 0);
}

// ── no interpolation ──────────────────────────────────────────────
{
  const a: YieldSeries = {
    label: "德國 2Y",
    source: "stooq",
    points: [
      { date: "2026-08-03", value: 2.5 },
      { date: "2026-08-04", value: 2.6 },
      { date: "2026-08-05", value: 2.7 },
    ],
  };
  // The US leg is missing 08-04 — a holiday, say.
  const b: YieldSeries = {
    label: "美國 2Y",
    source: "fred",
    points: [
      { date: "2026-08-03", value: 4.0 },
      { date: "2026-08-05", value: 4.1 },
    ],
  };
  const aligned = alignSeries(a, b);
  check("only shared dates produce a spread", aligned.length === 2, aligned);
  check("the unmatched date is dropped, not filled", !aligned.some((x) => x.as_of === "2026-08-04"));
  check("the arithmetic is minuend − subtrahend", aligned[0].spread === 2.5 - 4.0, aligned[0]);
  check("results are chronological", aligned[0].as_of < aligned[1].as_of);

  const none = alignSeries(a, { label: "x", source: "stooq", points: [{ date: "2020-01-01", value: 1 }] });
  check("no overlap yields nothing", none.length === 0);
}

// ── staleness ─────────────────────────────────────────────────────
{
  check("same day is 0 business days", businessDaysBetween("2026-08-04", new Date("2026-08-04T12:00:00Z")) === 0);
  check("Tue → Thu is 2", businessDaysBetween("2026-08-04", new Date("2026-08-06T12:00:00Z")) === 2);
  // 2026-08-07 is a Friday; the following Monday is 10 Aug.
  check("a weekend does not count", businessDaysBetween("2026-08-07", new Date("2026-08-10T12:00:00Z")) === 1);
  check("an unparseable date is infinitely stale", businessDaysBetween("not-a-date", new Date()) === Infinity);
}

const config = RATE_SPREADS.EURUSD;

// ── the happy path ────────────────────────────────────────────────
{
  // German 2Y climbs 0.30pp over 20 sessions while the US stays flat:
  // the spread widens 30bp in favour of the euro.
  const de = series("德國 2Y", "2026-08-04", [
    ...Array.from({ length: 21 }, (_, i) => 2.4 + (i * 0.3) / 20),
  ]);
  const us = series("美國 2Y", "2026-08-04", Array.from({ length: 21 }, () => 4.0));
  const gaps: string[] = [];
  const r = computeRateSpread(config, de, us, gaps, new Date("2026-08-04T12:00:00Z"));

  check("a factor is produced", r.item !== null, gaps);
  check("the 20-day change is 30bp", r.changeBp === 30, r.changeBp);
  check("a widening spread reads long", r.item?.direction === "long", r.item?.direction);
  check(">25bp earns weight 2", r.item?.weight === 2);
  check("it lands in 基本面", r.item?.dimension === "基本面");
  check("the factor is named from config", r.item?.factor === "2Y 德美利差", r.item?.factor);
  check("evidence carries the current level", r.item?.evidence.includes("-1.30%") === true, r.item?.evidence);
  check("evidence carries the 20-day change", r.item?.evidence.includes("20日擴大 30bp") === true, r.item?.evidence);
  check("evidence carries as_of", r.item?.evidence.includes("as_of 2026-08-04") === true, r.item?.evidence);
  check("no gap on the happy path", gaps.length === 0, gaps);

  // The mirror image: the same move against the euro.
  const deDown = series("德國 2Y", "2026-08-04", Array.from({ length: 21 }, (_, i) => 2.7 - (i * 0.3) / 20));
  const r2 = computeRateSpread(config, deDown, us, [], new Date("2026-08-04T12:00:00Z"));
  check("a narrowing spread reads short", r2.item?.direction === "short", r2.item?.direction);
  check("and says 收斂", r2.item?.evidence.includes("收斂") === true, r2.item?.evidence);

  // Barely moving: real weight 0, and a weight-0 item must not claim a direction.
  const flat = series("德國 2Y", "2026-08-04", Array.from({ length: 21 }, (_, i) => 2.4 + (i * 0.05) / 20));
  const r3 = computeRateSpread(config, flat, us, [], new Date("2026-08-04T12:00:00Z"));
  check("a 5bp move scores 0", r3.item?.weight === 0, r3.changeBp);
  check("a zero-weight item is neutral", r3.item?.direction === "neutral", r3.item?.direction);
}

// ── refusals ──────────────────────────────────────────────────────
{
  const de = series("德國 2Y", "2026-08-04", Array.from({ length: 21 }, () => 2.5));
  const us = series("美國 2Y", "2026-08-04", Array.from({ length: 21 }, () => 4.0));

  // Four business days later — beyond the 3-day tolerance.
  const gaps: string[] = [];
  const stale = computeRateSpread(config, de, us, gaps, new Date("2026-08-10T12:00:00Z"));
  check("stale data produces no factor", stale.item === null);
  check("staleness is reported", gaps.some((g) => g.includes("落後")), gaps);
  check("the spread is still returned for inspection", stale.spread === -1.5, stale.spread);

  // Two business days later — inside tolerance, EOD lag is normal.
  const fresh = computeRateSpread(config, de, us, [], new Date("2026-08-06T12:00:00Z"));
  check("a 2-day lag is accepted", fresh.item !== null);

  // Not enough overlapping history for a 20-session lookback.
  const shortGaps: string[] = [];
  const short = computeRateSpread(
    config,
    series("德國 2Y", "2026-08-04", [2.5, 2.6]),
    series("美國 2Y", "2026-08-04", [4.0, 4.0]),
    shortGaps,
    new Date("2026-08-04T12:00:00Z"),
  );
  check("too little history produces no factor", short.item === null);
  check("and says so", shortGaps.some((g) => g.includes("不足")), shortGaps);

  // No shared dates at all.
  const noOverlapGaps: string[] = [];
  computeRateSpread(
    config,
    { label: "德國 2Y", source: "stooq", points: [{ date: "2026-08-04", value: 2.5 }] },
    { label: "美國 2Y", source: "fred", points: [{ date: "2026-07-01", value: 4.0 }] },
    noOverlapGaps,
    new Date("2026-08-04T12:00:00Z"),
  );
  check("no overlap is refused", noOverlapGaps.some((g) => g.includes("沒有共同的交易日")), noOverlapGaps);
  check("and it names the no-fill rule", noOverlapGaps.some((g) => g.includes("不以前值填補")));
}

// ── config sanity ─────────────────────────────────────────────────
{
  check("EURUSD uses the 2Y", rateSpreadFor("EURUSD")?.tenor === "2Y");
  check("GBPUSD uses the 2Y", rateSpreadFor("GBPUSD")?.tenor === "2Y");
  // The BOJ controlled the JGB long end, so 10Y is where policy shows up.
  check("USDJPY uses the 10Y", rateSpreadFor("USDJPY")?.tenor === "10Y");
  check("XAUUSD has no spread config", rateSpreadFor("XAUUSD") === null);
  check("indices have no spread config", rateSpreadFor("NAS100") === null);
  check("WTI has no spread config", rateSpreadFor("WTI") === null);

  // Every config must be arranged so a rising spread means long. USDJPY is the
  // one that would break if the legs were written in the intuitive order.
  check("USDJPY puts the US leg on top", rateSpreadFor("USDJPY")?.minuend.label === "美國 10Y");
  check("EURUSD puts the German leg on top", rateSpreadFor("EURUSD")?.minuend.label === "德國 2Y");
  for (const [symbol, cfg] of Object.entries(RATE_SPREADS)) {
    check(`${symbol} has a source for both legs`,
      Boolean(cfg.minuend.stooqCode || cfg.minuend.ecbKey || cfg.minuend.fredLabel) &&
      Boolean(cfg.subtrahend.stooqCode || cfg.subtrahend.ecbKey || cfg.subtrahend.fredLabel));
  }
}

report("rate spread");

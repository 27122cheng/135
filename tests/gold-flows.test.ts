import { check, report } from "./_harness";
import { buildGoldFlowItem } from "@/lib/analysis/gold-flows";
import { inferFrequency, periodEndDate } from "@/lib/data-sources/dbnomics";
import {
  DBNOMICS_GOLD_SOURCES,
  FREQUENCY_WEIGHT_CAP,
  maxAgeDays,
  type GoldFlowSource,
} from "@/config/gold-fundamentals";
import type { DbnomicsSeries } from "@/lib/data-sources/dbnomics";

/**
 * 央行購金／黃金流向. The rules that must not drift: weight is capped by
 * frequency, a stale series is dropped rather than scored, and no two
 * frequencies ever end up inside one factor.
 */

function source(over: Partial<GoldFlowSource> = {}): GoldFlowSource {
  return {
    id: "test",
    label: "測試來源",
    frequency: "monthly",
    series: ["IMF/IFS/TEST"],
    releaseLagDays: 7,
    risingMeans: "long",
    lookback: 3,
    minChangePct: 0.1,
    note: "n",
    ...over,
  };
}

function series(periods: string[], values: number[]): DbnomicsSeries {
  return {
    seriesId: "IMF/IFS/TEST",
    name: "test",
    points: periods.map((period, i) => ({ period, value: values[i] })),
  };
}

// ── period parsing ────────────────────────────────────────────────
{
  // Freshness must be measured from the end of the period, not its label.
  check("a month ends on its last day",
    periodEndDate("2026-07")?.toISOString().slice(0, 10) === "2026-07-31",
    periodEndDate("2026-07")?.toISOString());
  check("February is handled", periodEndDate("2026-02")?.toISOString().slice(0, 10) === "2026-02-28");
  check("a quarter ends on its last day",
    periodEndDate("2026-Q2")?.toISOString().slice(0, 10) === "2026-06-30");
  check("a daily period is itself",
    periodEndDate("2026-08-04")?.toISOString().slice(0, 10) === "2026-08-04");
  check("a year ends in December",
    periodEndDate("2026")?.toISOString().slice(0, 10) === "2026-12-31");
  check("an unknown format is null", periodEndDate("garbage") === null);
}

// ── the weight ceiling ────────────────────────────────────────────
{
  check("daily caps at 2", FREQUENCY_WEIGHT_CAP.daily === 2);
  check("weekly caps at 2", FREQUENCY_WEIGHT_CAP.weekly === 2);
  check("monthly caps at 1", FREQUENCY_WEIGHT_CAP.monthly === 1);
  // Quarterly is background for charts, never a vote.
  check("quarterly caps at 0", FREQUENCY_WEIGHT_CAP.quarterly === 0);

  const now = new Date("2026-08-10T00:00:00Z");
  const periods = ["2026-04", "2026-05", "2026-06", "2026-07"];

  const monthly = buildGoldFlowItem(source(), series(periods, [100, 101, 102, 110]), now);
  check("a monthly factor is produced", monthly.item !== null, monthly.reason);
  check("monthly never exceeds weight 1", monthly.item?.weight === 1, monthly.item?.weight);

  const weekly = buildGoldFlowItem(
    source({ frequency: "weekly", releaseLagDays: 7 }),
    series(["2026-07-20", "2026-07-27", "2026-08-03", "2026-08-08"], [100, 101, 102, 110]),
    now,
  );
  check("weekly reaches weight 2", weekly.item?.weight === 2, weekly.item?.weight);

  const quarterly = buildGoldFlowItem(
    source({ frequency: "quarterly", releaseLagDays: 20, lookback: 1 }),
    series(["2026-Q1", "2026-Q2"], [100, 130]),
    now,
  );
  check("quarterly stays at weight 0 even on a big move", quarterly.item?.weight === 0, quarterly.item);
  check("and therefore claims no direction", quarterly.item?.direction === "neutral");
}

// ── direction ─────────────────────────────────────────────────────
{
  const now = new Date("2026-08-10T00:00:00Z");
  const periods = ["2026-04", "2026-05", "2026-06", "2026-07"];

  const buying = buildGoldFlowItem(source(), series(periods, [100, 101, 102, 110]), now);
  check("central banks buying reads long", buying.item?.direction === "long");

  const selling = buildGoldFlowItem(source(), series(periods, [110, 105, 102, 100]), now);
  check("central banks selling reads short", selling.item?.direction === "short");

  // Below the noise floor: report the number, claim nothing.
  const flat = buildGoldFlowItem(source(), series(periods, [100, 100, 100, 100.02]), now);
  check("a 0.02% move is not a signal", flat.item?.weight === 0, flat.item?.evidence);
  check("and reads neutral", flat.item?.direction === "neutral");
  check("but the number is still shown", flat.item?.evidence.includes("100.02") === true, flat.item?.evidence);

  // A source where rising is bearish still inverts correctly.
  const inverted = buildGoldFlowItem(
    source({ risingMeans: "short" }),
    series(periods, [100, 101, 102, 110]),
    now,
  );
  check("risingMeans is honoured", inverted.item?.direction === "short");
}

// ── the freshness gate ────────────────────────────────────────────
{
  const periods = ["2026-01", "2026-02", "2026-03", "2026-04"];
  const values = [100, 101, 102, 110];
  const monthly = source(); // 31 + 7 + 7 = 45 days

  check("the age limit is period + lag + slack", maxAgeDays(monthly) === 45, maxAgeDays(monthly));

  // 2026-04 ends 30 Apr. On 1 June that is 32 days old — inside the limit.
  const fresh = buildGoldFlowItem(monthly, series(periods, values), new Date("2026-06-01T00:00:00Z"));
  check("a normal publication lag is accepted", fresh.item !== null, fresh.reason);

  // On 1 July it is 62 days old — the series has stopped updating.
  const stale = buildGoldFlowItem(monthly, series(periods, values), new Date("2026-07-01T00:00:00Z"));
  check("a stalled series is dropped", stale.item === null);
  check("and the reason names the limit", stale.reason?.includes("上限 45 天") === true, stale.reason);
  check("the reason gives the age", stale.reason?.includes("已過期") === true, stale.reason);

  // A slow source is allowed to be slow — the IMF aggregate lags 45 days.
  const slow = source({ releaseLagDays: 45 }); // 31 + 45 + 7 = 83
  const slowOk = buildGoldFlowItem(slow, series(periods, values), new Date("2026-07-01T00:00:00Z"));
  check("a source with a declared long lag is not punished for it", slowOk.item !== null, slowOk.reason);
}

// ── the data's own cadence beats the declared one ──────────────────
{
  // This is the 印度 RBI bug: configured weekly, DBnomics returns monthly. The
  // 21-day weekly clock disabled it on every single run even though the series
  // was publishing exactly on schedule.
  const declaredWeekly = source({ frequency: "weekly", releaseLagDays: 7, lookback: 3 });
  const monthlyData = series(["2026-04", "2026-05", "2026-06", "2026-07"], [100, 101, 102, 110]);
  const now = new Date("2026-08-10T00:00:00Z"); // 2026-07 ended 10 days ago

  check("monthly data is judged on a monthly clock, not the declared weekly one",
    buildGoldFlowItem(declaredWeekly, monthlyData, now).item !== null);
  check("the age limit follows the observed frequency",
    maxAgeDays(declaredWeekly, "monthly") === 45, maxAgeDays(declaredWeekly, "monthly"));

  // But the weight still takes the coarser of the two: monthly data cannot be
  // scored at the weekly ceiling just because the config asked for it.
  check("the weight ceiling takes the coarser tier",
    buildGoldFlowItem(declaredWeekly, monthlyData, now).item?.weight === 1);
  check("and the factor is labelled with what the data actually is",
    buildGoldFlowItem(declaredWeekly, monthlyData, now).item?.factor.includes("月頻") === true);

  check("daily periods are recognised", inferFrequency(
    [{ period: "2026-08-03", value: 1 }, { period: "2026-08-04", value: 1 },
     { period: "2026-08-05", value: 1 }]) === "daily");
  check("weekly-spaced daily periods are recognised", inferFrequency(
    [{ period: "2026-07-20", value: 1 }, { period: "2026-07-27", value: 1 },
     { period: "2026-08-03", value: 1 }]) === "weekly");
  check("month labels are recognised", inferFrequency(
    [{ period: "2026-06", value: 1 }, { period: "2026-07", value: 1 }]) === "monthly");
  check("quarter labels are recognised", inferFrequency(
    [{ period: "2026-Q1", value: 1 }, { period: "2026-Q2", value: 1 }]) === "quarterly");
  check("year labels are recognised", inferFrequency(
    [{ period: "2025", value: 1 }, { period: "2026", value: 1 }]) === "yearly");
  check("a single point tells us nothing", inferFrequency([{ period: "2026-07", value: 1 }]) === null);
  check("mixed formats tell us nothing", inferFrequency(
    [{ period: "2026-07", value: 1 }, { period: "2026-Q2", value: 1 }]) === null);
}

// ── refusals ──────────────────────────────────────────────────────
{
  const now = new Date("2026-08-10T00:00:00Z");
  const short = buildGoldFlowItem(source(), series(["2026-06", "2026-07"], [100, 110]), now);
  check("too few observations is refused", short.item === null);
  check("and says how many it had", short.reason?.includes("只有 2 筆") === true, short.reason);

  const zeroBase = buildGoldFlowItem(
    source(),
    series(["2026-04", "2026-05", "2026-06", "2026-07"], [0, 1, 2, 3]),
    now,
  );
  check("a zero base is refused rather than dividing by it", zeroBase.item === null, zeroBase.reason);

  const badPeriod = buildGoldFlowItem(
    source(),
    series(["a", "b", "c", "d"], [100, 101, 102, 110]),
    now,
  );
  check("an unparseable period is refused", badPeriod.item === null);
  check("and names the format", badPeriod.reason?.includes("無法解析期間格式") === true, badPeriod.reason);
}

// ── no mixing of frequencies ──────────────────────────────────────
{
  const now = new Date("2026-08-10T00:00:00Z");
  // Each source produces its own item, so a blended factor is not representable.
  const monthly = buildGoldFlowItem(source({ label: "月頻來源" }), series(
    ["2026-04", "2026-05", "2026-06", "2026-07"], [100, 101, 102, 110]), now);
  const weekly = buildGoldFlowItem(source({ label: "週頻來源", frequency: "weekly" }), series(
    ["2026-07-20", "2026-07-27", "2026-08-03", "2026-08-08"], [100, 101, 102, 110]), now);

  check("each source is its own factor", monthly.item?.factor !== weekly.item?.factor);
  check("the monthly factor is labelled 月頻", monthly.item?.factor.includes("月頻") === true, monthly.item?.factor);
  check("the weekly factor is labelled 週頻", weekly.item?.factor.includes("週頻") === true, weekly.item?.factor);
  check("their weights differ by tier", monthly.item?.weight !== weekly.item?.weight);
  // Evidence must carry as_of so a reader can see which period each covers.
  check("monthly evidence carries its own as_of", monthly.item?.evidence.includes("as_of 2026-07") === true);
  check("weekly evidence carries its own as_of", weekly.item?.evidence.includes("as_of 2026-08-08") === true);
}

// ── config sanity ─────────────────────────────────────────────────
{
  check("every source has at least one DBnomics candidate",
    DBNOMICS_GOLD_SOURCES.every((s) => s.series.length >= 1));
  check("every candidate is a provider/dataset/series id",
    DBNOMICS_GOLD_SOURCES.every((s) => s.series.every((id) => id.split("/").length === 3)));
  check("candidates within a source are distinct",
    DBNOMICS_GOLD_SOURCES.every((s) => new Set(s.series).size === s.series.length));
  check("every source declares a release lag", DBNOMICS_GOLD_SOURCES.every((s) => s.releaseLagDays > 0));
  check("every source declares a lookback", DBNOMICS_GOLD_SOURCES.every((s) => s.lookback >= 1));
  check("ids are unique", new Set(DBNOMICS_GOLD_SOURCES.map((s) => s.id)).size === DBNOMICS_GOLD_SOURCES.length);
  // The PBoC print is the one the market watches; it must be in the list.
  check("PBoC is configured", DBNOMICS_GOLD_SOURCES.some((s) => s.id === "pboc-reserves"));
  check("every source's weight cap is a valid weight",
    DBNOMICS_GOLD_SOURCES.every((s) => [0, 1, 2].includes(FREQUENCY_WEIGHT_CAP[s.frequency])));
}

report("gold flows");

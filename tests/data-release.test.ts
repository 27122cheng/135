import { check, report } from "./_harness";
import {
  buildReleaseItem,
  compare,
  findEstimate,
  hoursSince,
} from "@/lib/analysis/data-release";
import {
  TRACKED_RELEASES,
  directionFromUsd,
  releaseBySeriesId,
} from "@/config/data-releases";
import { FUNDAMENTALS_CONFIG } from "@/config/fundamentals";
import { COMMODITIES } from "@/types/signal";
import type { StoredRelease } from "@/lib/db";

/**
 * 即時數據公布. The rules that must not drift: a print outside its impact
 * window is not a factor, a comparison against the previous print must never be
 * presented as a surprise versus consensus, and the direction has to agree with
 * the DXY factor's reading of what a strong dollar means.
 */

const XAU = COMMODITIES.find((c) => c.symbol === "XAUUSD")!;
const JPY = COMMODITIES.find((c) => c.symbol === "USDJPY")!;

function stored(over: Partial<StoredRelease> = {}): StoredRelease {
  return {
    seriesId: "CPIAUCSL",
    period: "2026-07-01",
    value: 320,
    previousValue: 318,
    estimate: null,
    firstSeenAt: new Date("2026-08-05T12:00:00Z").toISOString(),
    ...over,
  };
}

// ── the dollar channel ────────────────────────────────────────────
{
  // These four must match lib/analysis/fundamental.ts's DXY branch exactly:
  //   dxyDown !== config.dxyInverted ? "long" : "short"
  check("weak dollar is long for gold", directionFromUsd("weaker", false) === "long");
  check("strong dollar is short for gold", directionFromUsd("stronger", false) === "short");
  // USD/JPY is quoted the other way up.
  check("weak dollar is short for USDJPY", directionFromUsd("weaker", true) === "short");
  check("strong dollar is long for USDJPY", directionFromUsd("stronger", true) === "long");

  check("XAUUSD is not inverted", FUNDAMENTALS_CONFIG.XAUUSD.dxyInverted === false);
  check("USDJPY is inverted", FUNDAMENTALS_CONFIG.USDJPY.dxyInverted === true);
}

// ── hot vs cool ───────────────────────────────────────────────────
{
  const now = new Date("2026-08-05T18:00:00Z");

  const hot = buildReleaseItem(stored(), XAU, FUNDAMENTALS_CONFIG.XAUUSD, now);
  check("a hot CPI is bearish for gold", hot?.direction === "short", hot);
  check("and carries the release's weight", hot?.weight === 2, hot?.weight);
  check("it lands in 基本面", hot?.dimension === "基本面");
  check("the factor names the print", hot?.factor.includes("美國 CPI") === true, hot?.factor);
  check("and says which way the dollar goes", hot?.factor.includes("美元偏強") === true, hot?.factor);

  // Same print, opposite direction of surprise.
  const cool = buildReleaseItem(stored({ value: 316 }), XAU, FUNDAMENTALS_CONFIG.XAUUSD, now);
  check("a cool CPI is bullish for gold", cool?.direction === "long", cool);
  check("and says the dollar softens", cool?.factor.includes("美元偏弱") === true, cool?.factor);

  // The same event must point the other way for a USD-base pair.
  const jpy = buildReleaseItem(stored(), JPY, FUNDAMENTALS_CONFIG.USDJPY, now);
  check("a hot CPI is bullish for USDJPY", jpy?.direction === "long", jpy);

  // Unemployment is the inverted one: a higher print is dovish.
  const unrate = buildReleaseItem(
    stored({ seriesId: "UNRATE", value: 4.6, previousValue: 4.2 }),
    XAU,
    FUNDAMENTALS_CONFIG.XAUUSD,
    now,
  );
  check("rising unemployment weakens the dollar", unrate?.direction === "long", unrate);
}

// ── the expiry window ─────────────────────────────────────────────
{
  const seenAt = "2026-08-05T12:00:00Z";
  const cpi = releaseBySeriesId("CPIAUCSL")!;
  check("CPI stays a factor for 48h", cpi.impactHours === 48);

  const within = buildReleaseItem(
    stored({ firstSeenAt: seenAt }),
    XAU,
    FUNDAMENTALS_CONFIG.XAUUSD,
    new Date("2026-08-07T11:00:00Z"), // 47h
  );
  check("inside the window it scores", within !== null);

  const expired = buildReleaseItem(
    stored({ firstSeenAt: seenAt }),
    XAU,
    FUNDAMENTALS_CONFIG.XAUUSD,
    new Date("2026-08-07T13:00:00Z"), // 49h
  );
  // Dropped outright rather than faded — a half-weight stale print still moves
  // the grade while carrying no information.
  check("outside the window it is gone entirely", expired === null);

  const claims = buildReleaseItem(
    stored({ seriesId: "ICSA", value: 250000, previousValue: 220000, firstSeenAt: seenAt }),
    XAU,
    FUNDAMENTALS_CONFIG.XAUUSD,
    new Date("2026-08-06T13:00:00Z"), // 25h
  );
  check("weekly claims expire after 24h", claims === null);

  check("age is measured from first sighting", Math.round(
    hoursSince(seenAt, new Date("2026-08-06T12:00:00Z"))) === 24);
  check("an unparseable timestamp is infinitely old",
    hoursSince("nonsense", new Date()) === Number.POSITIVE_INFINITY);
}

// ── consensus vs previous ─────────────────────────────────────────
{
  const now = new Date("2026-08-05T18:00:00Z");

  const vsPrevious = compare(stored());
  check("without an estimate it compares to the previous print",
    vsPrevious?.basis === "前值", vsPrevious);

  const vsConsensus = compare(stored({ estimate: 319 }));
  check("an estimate wins when present", vsConsensus?.basis === "市場預期", vsConsensus);
  check("and the change is measured against it",
    Math.abs((vsConsensus?.changePct ?? 0) - ((320 - 319) / 319) * 100) < 1e-9);

  // The distinction has to survive into the text: "inflation rose" is not
  // "inflation beat", and a reader must not be able to confuse the two.
  const item = buildReleaseItem(stored(), XAU, FUNDAMENTALS_CONFIG.XAUUSD, now);
  check("a previous-value comparison disclaims the surprise reading",
    item?.evidence.includes("不代表優於／劣於預期") === true, item?.evidence);

  const withEstimate = buildReleaseItem(stored({ estimate: 319 }), XAU, FUNDAMENTALS_CONFIG.XAUUSD, now);
  check("a consensus comparison carries no such disclaimer",
    withEstimate?.evidence.includes("不代表優於") === false, withEstimate?.evidence);
  check("and names 市場預期 in the factor",
    withEstimate?.factor.includes("市場預期") === true, withEstimate?.factor);

  check("no baseline at all is not scoreable",
    compare(stored({ previousValue: null })) === null);
  check("a zero baseline is refused rather than divided by",
    compare(stored({ previousValue: 0 })) === null);
}

// ── the noise floor ───────────────────────────────────────────────
{
  const now = new Date("2026-08-05T18:00:00Z");
  // 318 → 318.05 is 0.016%, below CPI's 0.05% floor.
  const flat = buildReleaseItem(
    stored({ value: 318.05, previousValue: 318 }),
    XAU,
    FUNDAMENTALS_CONFIG.XAUUSD,
    now,
  );
  check("a move below the floor claims no direction", flat?.direction === "neutral", flat);
  check("and scores zero", flat?.weight === 0);
  check("but the number is still reported", flat?.factor.includes("318.05") === true, flat?.factor);
}

// ── calendar matching ─────────────────────────────────────────────
{
  const cpi = releaseBySeriesId("CPIAUCSL")!;
  const events = [
    { event: "Core CPI m/m", country: "US", time: "2026-08-05T12:30:00Z", impact: "high",
      actual: 0.3, estimate: 0.2, previous: 0.2 },
  ];
  check("a US calendar row supplies the estimate", findEstimate(cpi, events) === 0.2);

  // A euro-area print must never reach a US series — the transmission channel
  // this whole config is built on is the US rates curve.
  const euro = [
    { event: "CPI y/y", country: "EU", time: "2026-08-05T09:00:00Z", impact: "high",
      actual: 2.4, estimate: 2.3, previous: 2.3 },
  ];
  check("a non-US row is ignored", findEstimate(cpi, euro) === null);
  check("no calendar means no estimate", findEstimate(cpi, null) === null);

  const noEstimate = [
    { event: "CPI m/m", country: "US", time: "2026-08-05T12:30:00Z", impact: "high",
      actual: 0.3, estimate: null, previous: 0.2 },
  ];
  check("a row without a consensus yields none", findEstimate(cpi, noEstimate) === null);
}

// ── config sanity ─────────────────────────────────────────────────
{
  check("series ids are unique",
    new Set(TRACKED_RELEASES.map((r) => r.seriesId)).size === TRACKED_RELEASES.length);
  check("every release declares an impact window",
    TRACKED_RELEASES.every((r) => r.impactHours > 0 && r.impactHours <= 72));
  check("every release has aliases for calendar matching",
    TRACKED_RELEASES.every((r) => r.calendarAliases.length > 0));
  check("aliases are lowercase, since matching is",
    TRACKED_RELEASES.every((r) => r.calendarAliases.every((a) => a === a.toLowerCase())));
  check("weights stay within the 1–2 band",
    TRACKED_RELEASES.every((r) => r.weight === 1 || r.weight === 2));
  // The two labour readings that move opposite to everything else must keep
  // their inverted mapping; flipping one silently would invert live signals.
  check("unemployment rate is dovish when it rises",
    releaseBySeriesId("UNRATE")?.usdImpact === "weaker");
  check("jobless claims are dovish when they rise",
    releaseBySeriesId("ICSA")?.usdImpact === "weaker");
  check("CPI is hawkish when it rises",
    releaseBySeriesId("CPIAUCSL")?.usdImpact === "stronger");
  check("an unknown series has no config", releaseBySeriesId("NOPE") === undefined);
  // A print whose series isn't tracked must not become a factor by accident.
  check("an untracked series produces no item",
    buildReleaseItem(stored({ seriesId: "NOPE" }), XAU, FUNDAMENTALS_CONFIG.XAUUSD, new Date(
      "2026-08-05T18:00:00Z")) === null);
}

report("data releases");

import { check, report } from "./_harness";
import {
  advancePlan,
  formatMonitorAlert,
  INITIAL_MEMORY,
  type MonitorMemory,
} from "@/lib/monitor/plan-state";
import { buildAddOns } from "@/lib/analysis/add-on";
import type { AddOnLevel, EntryStructure, Grade, PathObstacle, TradePlan } from "@/types/signal";

/**
 * 加倉 levels and the 5-minute monitor state machine.
 */

function addOn(seq: 1 | 2 | 3, price: number, stop: number): AddOnLevel {
  return {
    sequence: seq,
    price,
    structure: "s",
    reason: "r",
    new_stop_loss: stop,
    new_stop_reason: "ns",
    locks_in_entry: stop >= 2000,
  };
}

function plan(over: Partial<TradePlan> = {}): TradePlan {
  return {
    stance: "enter",
    entry: 2000,
    stop_loss: 1980,
    take_profit: 2080,
    entry_reason: "e",
    stop_loss_reason: "s",
    take_profit_reason: "t",
    risk_reward: 4,
    confidence: "medium",
    summary: "s",
    add_ons: [addOn(1, 2020, 1995), addOn(2, 2040, 2015)],
    wait_for: null,
    decided_by: "ai",
    ...over,
  };
}

function step(price: number, memory: MonitorMemory, p = plan()) {
  return advancePlan({ direction: "long", plan: p, price, priceAgeMinutes: 15, memory });
}

// ── add-on construction ───────────────────────────────────────────
{
  const obstacles: PathObstacle[] = [
    { price: 2020, type: "前高", timeframe: "D1", strength: 2 },
    { price: 2040, type: "整數關卡", timeframe: "D1", strength: 2 },
    { price: 2060, type: "週線S/R", timeframe: "W1", strength: 3 },
    { price: 2090, type: "前高", timeframe: "W1", strength: 3 },
  ];
  const structures: EntryStructure[] = [
    { price: 1990, type: "前低", role: "support", timeframe: "D1", strength: 2, distance_pct: -0.5 },
    { price: 2010, type: "需求區", role: "support", timeframe: "D1", strength: 2, distance_pct: 0.5 },
    { price: 2030, type: "需求區", role: "support", timeframe: "H4", strength: 2, distance_pct: 1.5 },
    { price: 2050, type: "需求區", role: "support", timeframe: "H4", strength: 2, distance_pct: 2.5 },
  ];
  const base = {
    direction: "long" as const,
    grade: "A" as Grade,
    entry: 2000,
    stopLoss: 1980,
    takeProfit: 2080,
    entryStructures: structures,
    pathObstacles: obstacles,
    atr: 10,
  };
  const { levels, skipped } = buildAddOns(base);

  check("add-ons are produced", levels.length > 0, skipped);
  check("no skip reason when levels exist", skipped === null);
  check("never more than three", levels.length <= 3, levels.length);
  check("sequences are 1..n in order", levels.every((l, i) => l.sequence === i + 1), levels.map((l) => l.sequence));
  check("all sit beyond the entry", levels.every((l) => l.price > 2000), levels.map((l) => l.price));
  // Anything at or past the target is an exit, not an add-on.
  check("none at or beyond the target", levels.every((l) => l.price < 2080), levels.map((l) => l.price));
  check("levels ascend", levels.every((l, i) => i === 0 || l.price > levels[i - 1].price));
  // The rule that matters: adding size must tighten the stop, never widen it.
  check("every stop improves on the original", levels.every((l) => l.new_stop_loss > 1980), levels.map((l) => l.new_stop_loss));
  check("stops tighten monotonically",
    levels.every((l, i) => i === 0 || l.new_stop_loss >= levels[i - 1].new_stop_loss));
  check("no stop sits above its own add-on", levels.every((l) => l.new_stop_loss < l.price));
  check("each cites a real structure", levels.every((l) => l.structure.includes("@")), levels.map((l) => l.structure));
  // 不能用幾R來分配 — nothing here may be derived from a risk multiple.
  check("no level mentions R multiples", levels.every((l) => !/\dR\b/.test(l.reason + l.new_stop_reason)));
  // The reason must state the support/resistance property the rule requires.
  check("a long's reason claims 支撐", levels.every((l) => l.reason.includes("支撐")), levels[0]?.reason);

  // ── rule 1: direction confidence ──
  for (const grade of ["B", "C", "no-trade"] as Grade[]) {
    const weak = buildAddOns({ ...base, grade });
    check(`grade ${grade} produces no add-ons`, weak.levels.length === 0, weak.levels);
    check(`grade ${grade} says why`, weak.skipped?.includes("信心不足") === true, weak.skipped);
  }
  check("A+ is allowed", buildAddOns({ ...base, grade: "A+" }).levels.length > 0);

  // ── rule 2/3: the level must be a real 支撐/壓力 ──
  const weakStructures = buildAddOns({
    ...base,
    pathObstacles: obstacles.map((o) => ({ ...o, strength: 1 as const })),
  });
  check("strength-1 levels are refused", weakStructures.levels.length === 0, weakStructures.levels);
  check("and the refusal names the reason",
    weakStructures.skipped?.includes("強度都只有 1") === true, weakStructures.skipped);

  // A mix: only the strong ones qualify.
  const mixed = buildAddOns({
    ...base,
    pathObstacles: [
      { price: 2020, type: "前高", timeframe: "D1", strength: 1 },
      { price: 2040, type: "週線S/R", timeframe: "W1", strength: 3 },
    ],
  });
  check("weak levels are skipped, strong ones kept",
    mixed.levels.length === 1 && mixed.levels[0].price === 2040, mixed.levels.map((l) => l.price));

  // Short side is the mirror image.
  const shortResult = buildAddOns({
    ...base,
    direction: "short",
    stopLoss: 2020,
    takeProfit: 1920,
    entryStructures: structures.map((s) => ({
      ...s,
      role: "resistance" as const,
      price: 4000 - s.price,
    })),
    pathObstacles: obstacles.map((o) => ({ ...o, price: 4000 - o.price })),
  });
  check("short add-ons sit below the entry", shortResult.levels.every((l) => l.price < 2000), shortResult.levels.map((l) => l.price));
  check("short stops improve downward", shortResult.levels.every((l) => l.new_stop_loss < 2020), shortResult.levels.map((l) => l.new_stop_loss));
  check("a short's reason claims 壓力", shortResult.levels.every((l) => l.reason.includes("壓力")), shortResult.levels[0]?.reason);

  // No structure behind the obstacles → nothing to anchor a new stop to.
  const noStops = buildAddOns({
    ...base,
    entryStructures: [],
    pathObstacles: [{ price: 2020, type: "前高", timeframe: "D1", strength: 2 }],
  });
  check("no anchorable stop means no add-on", noStops.levels.length === 0, noStops.levels);
  check("and it says so", noStops.skipped?.includes("沒有可錨定的保護結構") === true, noStops.skipped);

  // Levels too close together are one level with extra steps.
  const crowded = buildAddOns({
    ...base,
    pathObstacles: [
      { price: 2020, type: "前高", timeframe: "D1", strength: 2 },
      { price: 2021, type: "前高", timeframe: "D1", strength: 2 },
    ],
  });
  check("levels 1 point apart collapse to one", crowded.levels.length === 1, crowded.levels.map((l) => l.price));

  // Nothing between entry and target at all.
  const empty = buildAddOns({ ...base, pathObstacles: [] });
  check("no obstacles means no add-ons", empty.levels.length === 0);
  check("and names that case", empty.skipped?.includes("沒有可錨定的結構") === true, empty.skipped);
}

// ── monitor state machine ─────────────────────────────────────────
{
  // The entry is a limit order at a pullback level, so a long fills when
  // price comes DOWN to it. Price above the entry is a market that ran off
  // without you — not a fill.
  const above = step(2001, INITIAL_MEMORY);
  check("price on the profit side of the entry fills nobody", above.events.length === 0, above.events);
  check("and stays in waiting", above.memory.state === "waiting");

  // The exact bug that pushed a fictional XAUUSD win three times: a stale
  // plan's levels below a risen market let one price be "entry touched" and
  // "target hit" at once. With fill semantics it is a contradiction.
  const pastTarget = step(2085, INITIAL_MEMORY);
  check("a price already past the target fills nobody",
    pastTarget.events.length === 0 && pastTarget.memory.state === "waiting", pastTarget.memory);

  const entered = step(2000, INITIAL_MEMORY);
  check("touching the entry fires once", entered.events.length === 1 && entered.events[0].kind === "entered");
  check("state becomes entered", entered.memory.state === "entered");
  check("the active stop starts at the plan's stop", entered.memory.activeStop === 1980);
  check("a dip below the entry but above the stop also fills",
    step(1990, INITIAL_MEMORY).memory.state === "entered");

  // A gap straight through the zone to below the stop is a fill AND a stop —
  // reported honestly as both, in order.
  const gapped = step(1975, INITIAL_MEMORY);
  check("a gap through entry and stop reports both",
    gapped.events.map((e) => e.kind).join(",") === "entered,stop_hit", gapped.events);

  // Same state on the next run: silence. This is what stops 288 daily alerts.
  const again = step(2005, entered.memory);
  check("an unchanged state is silent", again.events.length === 0, again.events);

  const added = step(2021, entered.memory);
  check("reaching an add-on reports it", added.events.some((e) => e.kind === "add_on"));
  check("and moves the stop", added.events.some((e) => e.kind === "stop_moved"));
  // 2021 is past 1R (entry 2000, risk 20), so the breakeven rule lifts the
  // stop to the entry — and the add-on's suggested 1995 must NOT drag it back
  // down. A stop only ever moves toward safety; the tighter of the two stands.
  check("the stop actually changes — to the tighter of breakeven and the add-on's",
    added.memory.activeStop === 2000, added.memory.activeStop);
  check("the fill is remembered", added.memory.addOnsFilled === 1);

  const addedAgain = step(2025, added.memory);
  check("the same add-on is not re-announced", addedAgain.events.length === 0, addedAgain.events);

  // A jump past both levels reports each one, in order.
  const jumped = step(2045, entered.memory);
  check("a gap through two levels reports both",
    jumped.events.filter((e) => e.kind === "add_on").length === 2, jumped.events);
  check("and ends on the later stop", jumped.memory.activeStop === 2015, jumped.memory.activeStop);

  // The moved stop is the one that counts from then on.
  const stoppedOnNewStop = step(1994, added.memory);
  check("the raised stop is what triggers", stoppedOnNewStop.memory.state === "stop_hit", stoppedOnNewStop.memory);
  check("1994 would not have hit the original 1980",
    step(1994, entered.memory).memory.state === "entered");

  const target = step(2085, entered.memory);
  check("the target reports and terminates", target.memory.state === "target_hit");
  check("it points at the journal", target.events.some((e) => e.detail.includes("/review")));

  // Both hit in one delayed candle: report the stop. We can't know the intrabar
  // order, so the pessimistic reading is the only honest one.
  const both = advancePlan({
    direction: "long",
    plan: plan({ take_profit: 2010, stop_loss: 1995 }),
    price: 1990,
    priceAgeMinutes: 15,
    memory: { state: "entered", addOnsFilled: 0, activeStop: 1995 },
  });
  check("an ambiguous candle reports the stop", both.memory.state === "stop_hit", both.memory.state);

  // Terminal states stay terminal.
  const afterStop = step(2100, { state: "stop_hit", addOnsFilled: 0, activeStop: 1980 });
  check("a closed trade stops reporting", afterStop.events.length === 0 && afterStop.memory.state === "stop_hit");

  // A waiting plan is never monitored into a position.
  const waiting = advancePlan({
    direction: "long",
    plan: plan({ stance: "wait", entry: null, stop_loss: null }),
    price: 2050,
    priceAgeMinutes: 15,
    memory: INITIAL_MEMORY,
  });
  check("a 觀望 plan produces nothing", waiting.events.length === 0);

  // Short side mirrors.
  const shortPlan = plan({
    entry: 2000, stop_loss: 2020, take_profit: 1920,
    add_ons: [addOn(1, 1980, 2005)],
  });
  const shortEntered = advancePlan({
    direction: "short", plan: shortPlan, price: 2001, priceAgeMinutes: 5, memory: INITIAL_MEMORY,
  });
  check("a short fills when price rises to the entry", shortEntered.memory.state === "entered");
  const shortAbove = advancePlan({
    direction: "short", plan: shortPlan, price: 1999, priceAgeMinutes: 5, memory: INITIAL_MEMORY,
  });
  check("a short below its entry is not filled", shortAbove.memory.state === "waiting");
  const shortAdd = advancePlan({
    direction: "short", plan: shortPlan, price: 1975, priceAgeMinutes: 5, memory: shortEntered.memory,
  });
  check("short add-on triggers below", shortAdd.memory.addOnsFilled === 1);
  // Price 1975 is past 1R for this short (entry 2000, risk 20 → 1R at 1980),
  // so the breakeven rule has already brought the stop to 2000 — tighter than
  // the add-on's suggested 2005. The tighter stop stands; a stop never
  // retreats toward risk.
  check("short stop moves down — to the tighter of breakeven and the add-on's",
    shortAdd.memory.activeStop === 2000, shortAdd.memory.activeStop);
}

// ── message ───────────────────────────────────────────────────────
{
  const { events } = step(2021, { state: "entered", addOnsFilled: 0, activeStop: 1980 });
  const text = formatMonitorAlert("XAUUSD", "long", events, 14.6, "https://x.app");
  check("names the symbol and direction", text.includes("XAUUSD") && text.includes("做多"));
  check("carries the add-on headline", text.includes("加倉點到達"));
  // At 2021 the stop move is the breakeven one (1R reached before the add-on's
  // 1995 could apply), so the alert carries that headline.
  check("carries the stop move", text.includes("保本") || text.includes("停損上移"), text);
  // The delay is the thing that must never be hidden.
  check("states the price delay", text.includes("延遲約 15 分鐘"), text);
  check("warns it is not for intraday", text.includes("H4/D1"));
  check("links back", text.includes("https://x.app"));
}

// ── which trade this is about, and whether adding is still wise ───
//
// 「沒有交易建議怎麼突然要我加倉」— an add-on alert days after entry, with
// nothing naming the position it belonged to, read as a recommendation out
// of nowhere. Two fixes: name the entry and its signal date on every push,
// and when the newest analysis has flipped away from this direction, say so
// on an add-on specifically — adding is the one action that increases risk.
{
  const { events: addOnEvents } = step(2021, { state: "entered", addOnsFilled: 0, activeStop: 1980 });

  const named = formatMonitorAlert("XAUUSD", "long", addOnEvents, 5, "https://x.app", {
    entry: 2000,
    generatedAt: "2026-08-21T09:00:00Z",
  });
  check("the push names the position it is about", named.includes("追蹤中的持倉：進場 2000"), named);
  check("and when the signal was generated", named.includes("08-21"), named);

  const stillSupported = formatMonitorAlert("XAUUSD", "long", addOnEvents, 5, "https://x.app", {
    entry: 2000, generatedAt: "2026-08-21T09:00:00Z", analysisSupports: true,
  });
  check("no warning when the newest analysis still agrees",
    !stillSupported.includes("不建議執行這次加倉"), stillSupported);

  const flipped = formatMonitorAlert("XAUUSD", "long", addOnEvents, 5, "https://x.app", {
    entry: 2000, generatedAt: "2026-08-21T09:00:00Z", analysisSupports: false,
  });
  check("a flipped analysis warns against the add-on specifically",
    flipped.includes("不建議執行這次加倉"), flipped);
  check("but says the stop move and the position itself are unaffected",
    flipped.includes("停損上移照常執行"), flipped);

  // A flip with no add-on in this batch (just a breakeven stop move, say)
  // must not warn — the caveat is scoped to the action that actually raises
  // risk. Add-on moved out to 2050 so it does not coincide with 1R (2020).
  const farAddOnPlan = plan({ add_ons: [addOn(1, 2050, 2010)] });
  const { events: stopOnly } = step(
    2020, { state: "entered", addOnsFilled: 0, activeStop: 1980 }, farAddOnPlan,
  );
  check("fixture sanity: only a stop move fired, no add-on",
    stopOnly.some((e) => e.kind === "stop_moved") && !stopOnly.some((e) => e.kind === "add_on"),
    stopOnly);
  const noAddOn = formatMonitorAlert("XAUUSD", "long", stopOnly, 5, "https://x.app", {
    entry: 2000, analysisSupports: false,
  });
  check("no add-on this round means no add-on warning",
    !noAddOn.includes("不建議執行這次加倉"), noAddOn);
}

// ── sticky tracking (structural) ──────────────────────────────────
//
// 「同一個商品的交易，必須要先結束，止盈或止損後再加入復盤」. The route
// snapshots the entered plan into plan_monitor and keeps watching it while
// the position is open; a behavioural test needs a live database, so what is
// pinned here is that the pieces exist and stay wired: the snapshot column,
// the in-flight check, and identity by generated_at rather than by ids that
// latest_signal fills with the symbol name.
{
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const route = readFileSync("app/api/monitor/route.ts", "utf8");
  check("open positions keep their snapshot", route.includes('row.state === "entered" || row.state === "added"'));
  check("plan identity is the snapshot's generated_at",
    route.includes("previous?.tracked?.generatedAt === tracked.generatedAt"));
  check("the snapshot is written back every sweep", route.includes("tracked,"));
  check("the journal records the tracked plan, not the newest analysis",
    route.includes("direction: tracked.direction, grade: tracked.grade"));
  // 810-minute-old quotes "filled" and "took profit on" a position three
  // times in one afternoon; a frozen feed must observe, not judge.
  check("a frozen quote judges nothing", route.includes("MAX_QUOTE_AGE_MINUTES"));
  // And a save the database accepts then forgets must not keep its mouth:
  // the state is read back, and an unreadable save is an unsaved one.
  check("the saved state is read back before anything is announced",
    route.includes("狀態寫入後重讀兩次都讀不回"));

  const schema = readFileSync("lib/db/schema.ts", "utf8");
  check("the schema migrates the tracked column",
    schema.includes("add column if not exists tracked jsonb"));
  const refresh = readFileSync("app/api/refresh/route.ts", "utf8");
  check("the refresh route reads the open-trade state before alerting",
    refresh.includes("openTrade"));
  // 「這筆信號一直發送」— a held-position withdrawal repeated on every
  // enter→wait oscillation because the route sent whatever shouldAlert
  // decided, with no memory of having already said it. The fix routes the
  // dedupeCategory tag through recordRelease, keyed to the tracked
  // position's own identity so a genuinely new position still gets its
  // own notice.
  check("a held-weakened decision is deduped through recordRelease",
    refresh.includes('decision.dedupeCategory === "held-weakened"') &&
    refresh.includes("recordRelease") &&
    refresh.includes("tracked?.generatedAt"),
    refresh);
  check("the dedupe fails open rather than silencing a real warning",
    refresh.includes(".catch(() => ({ isNew: true }))"), refresh);
}

report("monitor + add-ons");

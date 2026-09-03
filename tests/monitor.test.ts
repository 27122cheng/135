import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, report } from "./_harness";
import {
  advancePlan,
  formatMonitorAlert,
  INITIAL_MEMORY,
  type MonitorMemory,
} from "@/lib/monitor/plan-state";
import { pushWorthiness } from "@/lib/notify/alert";
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
  // 2021 is past 1R (entry 2000, risk 20) but NOT past PROVEN_R (2040), so
  // breakeven has not armed and the add-on's own suggested stop 1995 stands.
  // It is still a move toward safety from 1980; a stop never retreats.
  check("the stop actually changes — to the add-on's own suggestion",
    added.memory.activeStop === 1995, added.memory.activeStop);
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

  // ── 分批止盈 — a ≥1R target banks half; a sub-1R target exits in full ──
  // The default plan's target is 4R away (risk 20, tp +80), so it scales.
  // A shelf at 0.5R exits the whole position — banking half a crumb while
  // the rest washes at breakeven is the shape that zeroed every measured
  // expectancy on the live sweep.
  const nearShelf = advancePlan({
    direction: "long",
    plan: plan({ take_profit: 2010 }),
    price: 2012,
    priceAgeMinutes: 5,
    memory: { state: "entered", addOnsFilled: 0, activeStop: 1980 },
  });
  check("a sub-1R target exits in full, terminally",
    nearShelf.memory.state === "target_hit", nearShelf.memory.state);
  check("and says why the split did not apply",
    nearShelf.events.some((e) => e.kind === "target_hit" && e.detail.includes("不足 2R")),
    nearShelf.events);

  const target = step(2085, entered.memory);
  check("the target scales out instead of terminating", target.memory.state === "scaled", target.memory.state);
  check("the scale-out is announced", target.events.some((e) => e.kind === "scale_out"), target.events);
  check("the remainder's stop moves to at least the entry",
    target.memory.activeStop === 2000, target.memory.activeStop);
  const afterScale = step(2085, target.memory);
  check("a scaled position is silent while nothing changes", afterScale.events.length === 0, afterScale.events);
  check("and stays scaled", afterScale.memory.state === "scaled");
  // Add-ons are off the table in harvest mode — half is banked, the rest is
  // being trailed out; announcing "第 1 段加倉點到達" here would contradict it.
  check("no add-on fires after scaling out",
    afterScale.events.every((e) => e.kind !== "add_on") &&
    afterScale.memory.addOnsFilled === 0);
  // The remainder resolves at the (breakeven) stop, named as the half it is.
  const scaledStop = step(2000, target.memory);
  check("the remainder's stop-out terminates", scaledStop.memory.state === "stop_hit", scaledStop.memory.state);
  check("and says the first half was banked",
    scaledStop.events.some((e) => e.kind === "stop_hit" && e.headline.includes("剩餘半倉")), scaledStop.events);
  // 結束不是交作業給使用者。The message used to end with 「請到 /review 記錄
  // 並選一個 S1–S8 停損原因」 — asking the reader to hand-do the very
  // classification recordResolvedPlan performs seconds later, and never
  // showing them its answer.
  check("the close-out never asks the reader to classify it themselves",
    scaledStop.events.every((e) => !/請到 \/review|選一個 S1/.test(e.detail)), scaledStop.events);
  check("it says the system is settling it instead",
    scaledStop.events.some((e) => /系統/.test(e.detail)), scaledStop.events);

  // And the push carries the conclusion the journal just recorded.
  const withLesson = formatMonitorAlert("XAUUSD", "long", scaledStop.events, 5, "https://x.app", {
    entry: 2000,
    generatedAt: "2026-08-21T09:00:00Z",
    resolution: {
      kind: "觸及停損",
      result: "loss",
      pnlPct: -1.2,
      tag: "S3",
      label: "停損過窄被掃（結構抓對但 buffer 不足）",
      decidedBy: "rules",
      why: "最大順向 1.4R 後才回落觸及停損，方向判斷正確而停損距離不足。",
      consequence: "可事前預防。累積後會加大停損的 ATR buffer，讓停損離結構更遠。",
      severity: 4,
    },
  });
  check("the resolution push names the classified reason", withLesson.includes("S3"), withLesson);
  check("and who decided it", withLesson.includes("規則判定"), withLesson);
  check("and the reasoning written at classification time",
    withLesson.includes("最大順向 1.4R"), withLesson);
  check("and — the part that makes it learning — what changes next time",
    withLesson.includes("加大停損的 ATR buffer"), withLesson);
  check("and states it is already recorded, so nothing is asked of the reader",
    withLesson.includes("已寫入交易日誌"), withLesson);
  check("a win reports the settlement without inventing a stop reason", (() => {
    const win = formatMonitorAlert("XAUUSD", "long", scaledStop.events, 5, undefined, {
      resolution: {
        kind: "觸及停利", result: "win", pnlPct: 2.4, tag: null, label: null,
        decidedBy: null, why: null, consequence: null, severity: null,
      },
    });
    return (
      win.includes("獲利 +2.4%") &&
      // No classified-reason line at all — S1–S8 diagnoses stop-outs, and
      // labelling a winner with one would teach the intervention engine
      // something that never happened.
      !win.includes("停損原因（系統判定）") &&
      win.includes("只分類停損")
    );
  })());
  // A structure flip closes the scaled remainder too.
  const scaledFlip = advancePlan({
    direction: "long", plan: plan(), price: 2050, priceAgeMinutes: 5,
    memory: target.memory, structure: { trailStop: null, flipped: true },
  });
  check("a flip closes the scaled remainder", scaledFlip.memory.state === "structure_exit", scaledFlip.memory.state);
  check("named as the remaining half",
    scaledFlip.events.some((e) => e.kind === "structure_exit" && e.headline.includes("剩餘半倉")));
  // And the structure trailing keeps stepping the remainder's stop up.
  const scaledTrail = advancePlan({
    direction: "long", plan: plan(), price: 2060, priceAgeMinutes: 5,
    memory: target.memory, structure: { trailStop: 2030, flipped: false },
  });
  check("structure trailing still manages the scaled remainder",
    scaledTrail.memory.activeStop === 2030 &&
    scaledTrail.events.some((e) => e.kind === "stop_moved"), scaledTrail.memory);
  // The same tick cannot fill an entry AND scale out — fill logic (a long
  // fills at-or-below entry) makes entry+target in one tick contradictory.
  const fillAndTarget = step(1999, INITIAL_MEMORY);
  check("one tick cannot enter and scale out together",
    fillAndTarget.memory.state === "entered", fillAndTarget.memory.state);

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
  // Price 1975 is past 1R for this short (entry 2000, risk 20 → 1R at 1980)
  // but not past PROVEN_R (1960), so breakeven has not armed and the add-on's
  // own suggested 2005 stands — still a move toward safety from 2020.
  check("short stop moves down — to the add-on's own suggestion",
    shortAdd.memory.activeStop === 2005, shortAdd.memory.activeStop);
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

  // 進場那一則不重複自我介紹。「追蹤中的持倉：進場 X（訊號）」 followed by
  // 「已觸及進場價」 reads as the signal and the fill arriving together, when
  // it is one event described twice — the header introduces a position the
  // next line is announcing the opening of.
  const { events: fillEvents } = step(1999, INITIAL_MEMORY);
  const fill = formatMonitorAlert("XAUUSD", "long", fillEvents, 5, "https://x.app", {
    entry: 2000,
    generatedAt: "2026-08-21T09:00:00Z",
  });
  check("the fill message drops the redundant position header",
    fillEvents.some((e) => e.kind === "entered") && !fill.includes("追蹤中的持倉"), fill);
  check("but still says which signal the order came from",
    fill.includes("08-21 的訊號"), fill);
  check("and still announces the fill itself", fill.includes("已觸及進場價"), fill);

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
  // risk. Add-on moved out to 2060 so it does not coincide with PROVEN_R
  // (2040, since risk is 20).
  const farAddOnPlan = plan({ add_ons: [addOn(1, 2060, 2010)] });
  const { events: stopOnly } = step(
    2040, { state: "entered", addOnsFilled: 0, activeStop: 1980 }, farAddOnPlan,
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

// ── 補看漏掉的那段 ─────────────────────────────────────────────────
//
// The workflow asks GitHub for a run every five minutes; the last thirty
// scheduled runs came a median of 3.5 hours apart, max 12.3. Deciding from
// the spot price at each of those moments means every level touched in
// between is invisible — the entry tagged on a dip and recovered, the stop
// run through and bounced. Those trades were not mis-measured, they were
// never seen, which is why the site showed plans Telegram never mentioned.
{
  const held: MonitorMemory = { state: "entered", addOnsFilled: 0, activeStop: 1980 };
  const win = (high: number, low: number) => ({ high, low });
  const go = (price: number, memory: MonitorMemory, window?: { high: number; low: number }) =>
    advancePlan({ direction: "long", plan: plan(), price, priceAgeMinutes: 5, memory, window });

  // Price is back above the stop by the time anyone looks, but the window
  // says it traded through it. Under the old spot-only rule: silence.
  check("a stop touched inside the unobserved window still stops the trade",
    go(2010, held, win(2015, 1975)).memory.state === "stop_hit",
    go(2010, held, win(2015, 1975)).memory.state);
  check("and the same price with no window is silent — the regression it fixes",
    go(2010, held).events.length === 0, go(2010, held).events);
  check("the alert says the level was hit in the gap, not at the price shown",
    go(2010, held, win(2015, 1975)).events.some(
      (e) => e.kind === "stop_hit" && e.detail.includes("自上次檢查以來")),
    go(2010, held, win(2015, 1975)).events);

  // A target reached in the gap resolves the same way, off the window's high.
  const hitTp = go(2010, held, win(2090, 2000));
  check("a target touched inside the window resolves the trade",
    hitTp.memory.state === "scaled" || hitTp.memory.state === "target_hit", hitTp.memory.state);

  // An entry is a limit order, so a long fills off the window's LOW — the
  // dip that happened while nobody was watching.
  // Spot 2015 is above the entry, so without the window this never fills.
  const filled = go(2015, INITIAL_MEMORY, win(2015, 1995));
  check("a long fills on a dip inside the window even if price recovered",
    filled.memory.state === "entered", filled.memory.state);
  check("which the spot price alone would have missed entirely",
    go(2015, INITIAL_MEMORY).memory.state === "waiting");
  check("and a window that never dipped to the entry does not fill",
    go(2050, INITIAL_MEMORY, win(2060, 2005)).memory.state === "waiting");
  // The direction of the extreme matters: the window's HIGH must never fill
  // a long, or the fictional-trade bug walks straight back in.
  check("a window high above the entry cannot fill a long",
    go(2100, INITIAL_MEMORY, win(2200, 2050)).events.length === 0);

  // Pessimistic ordering survives: a window that covers both levels reports
  // the stop, because bars cannot order intrabar events.
  check("a window spanning stop and target reports the stop",
    go(2010, held, win(2090, 1975)).memory.state === "stop_hit");

  // Shorts mirror.
  const shortHeld: MonitorMemory = { state: "entered", addOnsFilled: 0, activeStop: 2020 };
  const shortPlan = plan({ entry: 2000, stop_loss: 2020, take_profit: 1920, add_ons: [] });
  const shortRes = advancePlan({
    direction: "short", plan: shortPlan, price: 1990, priceAgeMinutes: 5,
    memory: shortHeld, window: win(2025, 1985),
  });
  check("a short's stop is breached by the window's high", shortRes.memory.state === "stop_hit",
    shortRes.memory.state);
}

// ── 出場價是被觸及的價位，不是現在的價位 ─────────────────────────
//
// The route recorded every exit at the spot price. Correct only when the
// level is hit the instant the monitor looks; at a 3.5-hour gap it is wrong
// by hours and wrong in the worst direction — a stop run through at 09:00
// and recovered by 12:30 was booked at the 12:30 price, filing a loss as a
// profit. Structural, because it is one expression in a route with no unit
// seam and the failure is silent.
{
  const src = readFileSync(join(__dirname, "..", "app", "api", "monitor", "route.ts"), "utf8");
  const call = src.slice(src.indexOf("recordResolvedPlan({"), src.indexOf("review = logged.note"));
  check("a stop-out is journalled at the stop", /stop_hit"\s*\?\s*\(next\.activeStop/.test(call), call.slice(0, 400));
  check("a target is journalled at the target", call.includes("? plan.take_profit"), call);
  check("only a structure exit uses the spot price",
    (call.match(/quote\.price/g) ?? []).length === 1, call);
}

// ── 沒通知過你進場，就不會通知你成交 ─────────────────────────────
//
// The monitor pushed for any non-paper plan with no gate at all, while the
// signal push required grade ≥ B and ≥2 agreeing dimensions. So a signal the
// consensus bar had deliberately kept off the phone still announced 已觸及
// 進場價 when it filled — and that was the first the reader had heard of the
// trade. It reads as 「交易跟進場同時」 because there was no announcement:
// the fill was the announcement.
{
  const src = readFileSync(join(__dirname, "..", "app", "api", "monitor", "route.ts"), "utf8");
  check("the monitor gates its pushes on whether the signal was announced",
    /events\.length > 0 && !paper && announced/.test(src), "route.ts");
  check("the decision is snapshotted when tracking starts, not re-derived each sweep",
    /announced: paper \? false : pushWorthiness\(latest\)\.worthy/.test(src), "route.ts");
  check("a pre-existing row defaults to announced so a live trade cannot go silent",
    src.includes("tracked.announced ?? true"), "route.ts");
  check("and the sweep log says why the phone stayed quiet", src.includes("muted:"), "route.ts");

  // One predicate, three surfaces — the label, the signal push and the fill
  // push must never disagree about the same signal.
  const board = readFileSync(join(__dirname, "..", "lib", "board-row.ts"), "utf8");
  check("the board label uses the same predicate", board.includes("pushWorthiness(row)"), "board-row");
}

// ── the predicate itself ──────────────────────────────────────────
{
  const sig = (over: Record<string, unknown> = {}) =>
    ({
      grade: "A",
      direction: "long",
      bias_items: [
        { dimension: "技術面", direction: "long", weight: 2, factor: "" },
        { dimension: "基本面", direction: "long", weight: 2, factor: "" },
      ],
      trade_plan: { stance: "enter", entry: 100, stop_loss: 98, take_profit: 104 },
      ...over,
    }) as unknown as Parameters<typeof pushWorthiness>[0];

  check("a graded trade with two agreeing dimensions is push-worthy",
    pushWorthiness(sig()).worthy === true, pushWorthiness(sig()));
  check("one agreeing dimension is not, and says so",
    pushWorthiness(sig({
      bias_items: [{ dimension: "技術面", direction: "long", weight: 2, factor: "" }],
    })).reason?.includes("只在網站顯示") === true);
  check("a 觀望 signal is not a push at all",
    pushWorthiness(sig({ trade_plan: { stance: "wait" } })).worthy === false);
  check("a grade below the bar is refused by grade",
    pushWorthiness(sig({ grade: "C" })).reason?.includes("低於推播門檻") === true);
  check("a plan missing its levels is refused",
    pushWorthiness(sig({
      trade_plan: { stance: "enter", entry: 100, stop_loss: null, take_profit: 104 },
    })).reason?.includes("缺少價位") === true);
  check("a worthy signal carries no reason", pushWorthiness(sig()).reason === null);
}

// ── 論點失效就走，除非交易已經自己證明了 ─────────────────────────
//
// The thesis writes 「什麼會證明我看錯」 on the card and, for the regime
// kind, says the regime ending 「應收緊目標或退出」. Nothing checked it. Now
// the monitor does, with two bounds: only an open position, and not one that
// has already proven itself (stop at/beyond entry, or scaled).
{
  const broken = { trigger: "ER(20) 已跌到 0.12", meaning: "順勢回踩失去前提。" };
  const held: MonitorMemory = { state: "entered", addOnsFilled: 0, activeStop: 1980 };
  const go = (memory: MonitorMemory, regimeBroken: typeof broken | null, price = 2010) =>
    advancePlan({ direction: "long", plan: plan(), price, priceAgeMinutes: 5, memory,
      structure: { trailStop: null, flipped: false, regimeBroken } });

  const out = go(held, broken);
  check("an unproven open position exits when its regime ends", out.memory.state === "thesis_exit", out.memory.state);
  check("announced with the thesis's own trigger and meaning",
    out.events.some((e) => e.kind === "thesis_exit" && e.detail.includes("ER(20)") && e.detail.includes("順勢回踩")), out.events);
  check("it is terminal", go(out.memory, broken).events.length === 0);
  check("a regime that still holds changes nothing", go(held, null).events.length === 0);
  check("a waiting plan has nothing to exit", go(INITIAL_MEMORY, broken).memory.state === "waiting");
  // Proven trades are left to the trail — the banked half has paid for the rest.
  const proven: MonitorMemory = { state: "entered", addOnsFilled: 0, activeStop: 2000 };
  check("a position whose stop is already at entry is not exited on regime",
    go(proven, broken).events.length === 0);
  const scaled: MonitorMemory = { state: "scaled", addOnsFilled: 0, activeStop: 2000 };
  check("nor a scaled one", go(scaled, broken).events.length === 0);
  // Stop still wins inside the same sweep — pessimistic ordering survives.
  check("a stop breached in the same sweep reports the stop, not the thesis",
    go(held, broken, 1975).memory.state === "stop_hit");
  // Journalled like a structure exit: no S-tag, since it is not a stop-out.
  const autoLog = readFileSync(join(__dirname, "..", "lib", "journal", "auto-log.ts"), "utf8");
  check("auto-log treats a thesis exit like a structure exit — no stop taxonomy",
    autoLog.includes('outcome === "structure_exit" || outcome === "thesis_exit"'));
  const route = readFileSync(join(__dirname, "..", "app", "api", "monitor", "route.ts"), "utf8");
  check("the route derives the break from the snapshotted regime and today's ER",
    route.includes("regimeBrokenFor(tracked.regime") && route.includes("regime:\n"));
}

report("monitor + add-ons");

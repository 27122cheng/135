import { check, report } from "./_harness";
import { positionSize } from "@/lib/analysis/sizing";
import { upcomingHighImpactEvent, nfpTimeFor } from "@/lib/analysis/timing";
import { advancePlan, INITIAL_MEMORY, type MonitorMemory } from "@/lib/monitor/plan-state";
import { PROVEN_R } from "@/lib/analysis/lab-manage";
import type { TradePlan } from "@/types/signal";

/**
 * 交易執行面 — sizing, the breakeven stop, and the pre-event warning.
 *
 * These three share one property worth pinning hard: they may only ever
 * *reduce* risk. Sizing halves on correlation and never doubles; the
 * breakeven rule moves a stop toward safety and can never move it back; the
 * event warning tells a holder to cut, never to add.
 */

// ── 部位大小 ──────────────────────────────────────────────────────
{
  const base = {
    accountSize: 10_000,
    riskPct: 1,
    direction: "long" as const,
    entry: 4400,
    stopLoss: 4356,
    symbol: "XAUUSD",
  };
  const s = positionSize(base)!;
  check("risk amount is account × risk%", s.riskAmount === 100, s.riskAmount);
  // 100 risked over a 44-point stop distance → 2.2727 oz.
  check("units = risk ÷ stop distance", Math.abs(s.units - 2.27) < 0.01, s.units);
  check("gold converts to 100oz lots", s.lots !== null && Math.abs(s.lots - 0.02) < 0.01, s.lots);
  check("notional and leverage are stated",
    s.notional === 10_000 && s.leverage === 1, { notional: s.notional, leverage: s.leverage });

  const short = positionSize({ ...base, direction: "short", entry: 4356, stopLoss: 4400 })!;
  check("a short sizes off the same distance", short.riskAmount === 100 && short.units === s.units);

  const halved = positionSize({ ...base, correlatedHeld: ["EURUSD"] })!;
  check("a correlated held position halves the risk", halved.riskAmount === 50, halved.riskAmount);
  check("and says why, naming the position",
    halved.notes.some((n) => n.includes("EURUSD") && n.includes("減半")), halved.notes);
  check("the factor only ever reduces", halved.correlationFactor === 0.5 && s.correlationFactor === 1);

  // FX: 1% of 10k over a 50-pip stop on EURUSD.
  const fx = positionSize({
    accountSize: 10_000, riskPct: 1, direction: "long",
    entry: 1.085, stopLoss: 1.08, symbol: "EURUSD",
  })!;
  check("EURUSD sizes in base units", Math.abs(fx.units - 20_000) < 1, fx.units);
  check("and converts to standard lots", fx.lots !== null && Math.abs(fx.lots - 0.2) < 0.01, fx.lots);
  check("a tight stop's leverage is flagged, not hidden",
    fx.leverage > 2 && (fx.leverage <= 20 || fx.notes.some((n) => n.includes("倍"))), fx.leverage);

  // USDJPY: P&L accrues in JPY, so units convert through the rate.
  const jpy = positionSize({
    accountSize: 10_000, riskPct: 1, direction: "long",
    entry: 147, stopLoss: 146, symbol: "USDJPY",
  })!;
  // risk 100 USD over a 1-yen stop: 100 = units_base × 1 / 147 → 14,700 USD.
  check("USDJPY converts JPY risk into base units",
    Math.abs(jpy.units - 14_700) < 1, jpy.units);
  check("and states the approximation", jpy.notes.some((n) => n.includes("日圓")), jpy.notes);

  // Refusals: bad inputs must not produce a confident number.
  check("a stop on the wrong side is refused",
    positionSize({ ...base, stopLoss: 4444 }) === null);
  check("a zero stop distance is refused",
    positionSize({ ...base, stopLoss: 4400 }) === null);
  check("no account size, no number", positionSize({ ...base, accountSize: 0 }) === null);
}

// ── 保本移停 ──────────────────────────────────────────────────────
{
  const plan: TradePlan = {
    stance: "enter",
    entry: 100,
    stop_loss: 96,
    take_profit: 110,
    entry_reason: "", stop_loss_reason: "", take_profit_reason: "",
    risk_reward: 2.5, confidence: "medium", summary: "",
    add_ons: [], wait_for: null, decided_by: "fallback",
  };
  const entered: MonitorMemory = { state: "entered", addOnsFilled: 0, activeStop: 96 };
  const step = (price: number, memory: MonitorMemory) =>
    advancePlan({ direction: "long", plan, price, priceAgeMinutes: 1, memory });

  // Risk is 4; PROVEN_R (2R) in favour = 108. One R — 104 — is explicitly NOT
  // enough any more: arming breakeven there washed out 13% of every managed
  // trade at ±0R, which is the 「小獲利或止損」 profile the operator reported.
  const before = step(104, entered);
  check("at 1R the stop no longer moves — 1R is not proof",
    before.memory.activeStop === 96 && before.events.length === 0, before);

  const proven = step(108, entered);
  check(`at ${PROVEN_R}R the stop moves to the entry`, proven.memory.activeStop === 100,
    proven.memory);
  check("announced as a stop_moved event with the arithmetic",
    proven.events.some((e) => e.kind === "stop_moved" && e.detail.includes(`${PROVEN_R}R`)),
    proven.events);
  check("and says why the threshold is not 1R",
    proven.events.some((e) => e.kind === "stop_moved" && e.detail.includes("日常波動")),
    proven.events);
  check("and the state itself does not change", proven.memory.state === "entered");

  // Idempotent: the next tick at the same price must not re-announce.
  const again = step(108.5, proven.memory);
  check("it cannot fire twice", again.events.length === 0, again.events);

  // After the move, a return to entry stops out at breakeven, not at −1R.
  const scratched = step(100, proven.memory);
  check("a pullback to entry now exits at breakeven",
    scratched.memory.state === "stop_hit" && scratched.memory.activeStop === 100,
    scratched.memory);

  // A short mirrors: entry 100, stop 104, 2R = 92.
  const shortPlan = { ...plan, stop_loss: 104, take_profit: 88 };
  const shortMove = advancePlan({
    direction: "short", plan: shortPlan, price: 92, priceAgeMinutes: 1,
    memory: { state: "entered", addOnsFilled: 0, activeStop: 104 },
  });
  check(`a short's stop moves down to entry at ${PROVEN_R}R`,
    shortMove.memory.activeStop === 100, shortMove.memory);

  // Price beyond the TP scales out — half banked, remainder trailing at
  // breakeven — and the stop move folds into the scale_out event, not a
  // separate stop_moved announcement.
  const won = step(110, entered);
  check("reaching the target banks half and keeps the remainder",
    won.memory.state === "scaled" && won.memory.activeStop === 100, won.memory);

  // Waiting plans are untouched: no entry, no breakeven.
  const waiting = step(108, INITIAL_MEMORY);
  check("a plan that never filled cannot move its stop",
    waiting.events.every((e) => e.kind !== "stop_moved"), waiting.events);
}

// ── 結構式管理：移停與翻轉出場 ────────────────────────────────────
{
  const plan: TradePlan = {
    stance: "enter",
    entry: 100,
    stop_loss: 96,
    take_profit: 110,
    entry_reason: "", stop_loss_reason: "", take_profit_reason: "",
    risk_reward: 2.5, confidence: "medium", summary: "",
    add_ons: [], wait_for: null, decided_by: "fallback",
  };
  const entered: MonitorMemory = { state: "entered", addOnsFilled: 0, activeStop: 96 };
  const run = (
    price: number,
    memory: MonitorMemory,
    structure: { trailStop: number | null; flipped: boolean } | null,
  ) => advancePlan({ direction: "long", plan, price, priceAgeMinutes: 1, memory, structure });

  // A newly confirmed swing steps the stop up behind it.
  const trailed = run(103, entered, { trailStop: 98.5, flipped: false });
  check("a confirmed swing trails the stop up", trailed.memory.activeStop === 98.5, trailed.memory);
  check("announced as 結構移停",
    trailed.events.some((e) => e.kind === "stop_moved" && e.detail.includes("結構")), trailed.events);

  // Toward safety only — and never through the current price.
  const backward = run(103, trailed.memory, { trailStop: 97, flipped: false });
  check("a lower suggestion cannot drag the stop back",
    backward.memory.activeStop === 98.5 && backward.events.length === 0, backward.memory);
  const throughPrice = run(103, trailed.memory, { trailStop: 103.5, flipped: false });
  check("a stop through the price is refused",
    throughPrice.memory.activeStop === 98.5, throughPrice.memory);

  // 看法改變就出場：反向 CHoCH 以現價收掉部位，一次就終結。
  const flipped = run(103, entered, { trailStop: null, flipped: true });
  check("an opposite CHoCH closes the position at the market",
    flipped.memory.state === "structure_exit" &&
    flipped.events.some((e) => e.kind === "structure_exit"),
    flipped);
  const again = run(102, flipped.memory, { trailStop: null, flipped: true });
  check("and cannot fire twice", again.events.length === 0, again.events);

  // A stop that was actually run through beats the flip — pessimistic order.
  const stopFirst = run(95, entered, { trailStop: null, flipped: true });
  check("a breached stop reports the stop, not the flip",
    stopFirst.memory.state === "stop_hit", stopFirst.memory);

  // A waiting plan has nothing to close: no flip exit, no trailing.
  const waitingFlip = run(104, INITIAL_MEMORY, { trailStop: 99, flipped: true });
  check("a plan that never filled ignores the structure",
    waitingFlip.memory.state !== "structure_exit" &&
    waitingFlip.events.every((e) => e.kind !== "structure_exit"),
    waitingFlip);

  // No structure read at all: exactly the old behaviour.
  const noCtx = run(103, entered, null);
  check("without a structure read the plan is managed as before",
    noCtx.memory.activeStop === 96 && noCtx.events.length === 0, noCtx);
}

// ── 數據前警告 ────────────────────────────────────────────────────
{
  // The first Friday of June 2026 is the 5th; NFP at 12:30 UTC.
  const nfp = nfpTimeFor(2026, 5);
  check("NFP arithmetic finds the first Friday", nfp.toISOString().startsWith("2026-06-05T12:30"));

  const before = new Date(nfp.getTime() - 90 * 60 * 1000);
  const hit = upcomingHighImpactEvent(before, 2 * 60 * 60 * 1000);
  check("90 minutes before NFP, the warning window is open",
    hit !== null && hit.label.includes("非農") && hit.minutesAway === 90, hit);

  const far = new Date(nfp.getTime() - 5 * 60 * 60 * 1000);
  check("five hours out, it is not", upcomingHighImpactEvent(far, 2 * 60 * 60 * 1000) === null);

  const after = new Date(nfp.getTime() + 60 * 1000);
  const next = upcomingHighImpactEvent(after, 2 * 60 * 60 * 1000);
  check("a release that already landed does not warn",
    next === null || next.at.getTime() > after.getTime(), next);

  // FOMC 2026-09-16 18:00 UTC.
  const fomcAt = new Date("2026-09-16T18:00:00Z");
  const beforeFomc = upcomingHighImpactEvent(
    new Date(fomcAt.getTime() - 60 * 60 * 1000), 2 * 60 * 60 * 1000);
  check("FOMC warns the same way",
    beforeFomc !== null && beforeFomc.label.includes("FOMC"), beforeFomc);
}

report("交易執行面");

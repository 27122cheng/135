import { check, report } from "./_harness";
import {
  circuitBreaker,
  COOLDOWN_HOURS,
  DAILY_LOSS_LIMIT,
  STREAK_LOSS_LIMIT,
  stopCooldown,
} from "@/lib/journal/risk-guard";
import type { JournalEntry } from "@/types/journal";

/**
 * 帳戶層級的兩道閘 — same-symbol cooldown after a real loss, and the
 * book-wide circuit breaker. Both may only withdraw; both read real
 * auto-tracked rows only; both lift on their own.
 */

const NOW = new Date("2026-09-07T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
let seq = 0;
function row(over: Partial<JournalEntry> = {}): JournalEntry {
  seq++;
  return {
    id: `j-${seq}`,
    signal_id: null,
    symbol: "XAUUSD",
    direction: "long",
    grade: "B",
    entry_price: 2000,
    exit_price: 1980,
    result: "loss",
    pnl_pct: -1,
    closed_at: hoursAgo(2),
    stop_reason_tag: "S2",
    severity: 3,
    review_note: "[自動追蹤] 觸及停損",
    created_at: hoursAgo(2),
    ...over,
  };
}
const paper = (over: Partial<JournalEntry> = {}) =>
  row({ review_note: "[自動追蹤][參考價位紙上追蹤] 觸及停損", ...over });

// ── 停損後冷卻 ────────────────────────────────────────────────────
{
  const v = stopCooldown([row()], { symbol: "XAUUSD", direction: "long", now: NOW });
  check("a real loss two hours ago puts the same symbol+direction on cooldown", v.active, v);
  check("and says until when", v.until === new Date(NOW.getTime() + (COOLDOWN_HOURS - 2) * 3_600_000).toISOString(), v.until);
  check("the note names the rule", v.note?.includes("冷卻") === true, v.note);

  check("the other direction is a reversal, not revenge",
    !stopCooldown([row()], { symbol: "XAUUSD", direction: "short", now: NOW }).active);
  check("another symbol is unaffected",
    !stopCooldown([row()], { symbol: "EURUSD", direction: "long", now: NOW }).active);
  check("a paper loss is a measurement, not money",
    !stopCooldown([paper()], { symbol: "XAUUSD", direction: "long", now: NOW }).active);
  check("a hand-written loss does not count either",
    !stopCooldown([row({ review_note: "我自己記的" })], { symbol: "XAUUSD", direction: "long", now: NOW }).active);
  check("a win does not start a cooldown",
    !stopCooldown([row({ result: "win", pnl_pct: 2 })], { symbol: "XAUUSD", direction: "long", now: NOW }).active);
  check("a structure exit at a loss counts — the reason already failed",
    stopCooldown([row({ stop_reason_tag: null, review_note: "[自動追蹤] 結構翻轉出場" })],
      { symbol: "XAUUSD", direction: "long", now: NOW }).active);
  check("it lifts after COOLDOWN_HOURS",
    !stopCooldown([row({ closed_at: hoursAgo(COOLDOWN_HOURS + 1) })], { symbol: "XAUUSD", direction: "long", now: NOW }).active);
  check("the newest loss decides, whatever the row order",
    stopCooldown([row({ closed_at: hoursAgo(40) }), row({ closed_at: hoursAgo(3) })],
      { symbol: "XAUUSD", direction: "long", now: NOW }).active);
  check("nothing on an empty journal",
    !stopCooldown([], { symbol: "XAUUSD", direction: "long", now: NOW }).active);
}

// ── 帳戶熔斷 ──────────────────────────────────────────────────────
{
  const three = [
    row({ symbol: "XAUUSD", closed_at: hoursAgo(20) }),
    row({ symbol: "EURUSD", closed_at: hoursAgo(9) }),
    row({ symbol: "WTI", closed_at: hoursAgo(1) }),
  ];
  const v = circuitBreaker(three, NOW);
  check(`${DAILY_LOSS_LIMIT} real losses inside 24h trip the daily breaker`, v.tripped && v.rule === "daily", v);
  check("pause runs from the LAST loss",
    v.until === new Date(NOW.getTime() + 23 * 3_600_000).toISOString(), v.until);
  check("two losses do not", !circuitBreaker(three.slice(1), NOW).tripped);
  check("a loss 25 hours ago has rolled out of the day",
    !circuitBreaker([row({ closed_at: hoursAgo(25) }), ...three.slice(1)], NOW).tripped);
  check("paper losses never trip it",
    !circuitBreaker(three.map((e) => paper({ closed_at: e.closed_at, symbol: e.symbol })), NOW).tripped);

  // 連敗 — spread over days so the daily rule cannot be the one firing.
  const streak = Array.from({ length: STREAK_LOSS_LIMIT }, (_, i) =>
    row({ symbol: ["XAUUSD", "EURUSD", "WTI", "NAS100", "GBPUSD"][i], closed_at: hoursAgo(30 * (STREAK_LOSS_LIMIT - i)) }));
  const s = circuitBreaker(streak, NOW);
  check(`${STREAK_LOSS_LIMIT} consecutive real losses trip the streak breaker`, s.tripped && s.rule === "streak", s);
  check("a breakeven in the run is ignored, not a reset",
    circuitBreaker([...streak, row({ result: "breakeven", pnl_pct: 0, closed_at: hoursAgo(10) })], NOW).tripped);
  check("a win in the middle resets the run",
    !circuitBreaker([...streak.slice(0, 3), row({ result: "win", pnl_pct: 2, closed_at: hoursAgo(50) }), ...streak.slice(3)], NOW).tripped);
  check("the streak breaker lifts after its pause",
    !circuitBreaker(streak.map((e) => ({ ...e, closed_at: hoursAgo(60 + 30 * 5) })), NOW).tripped);
  check("a clean book is open", !circuitBreaker([], NOW).tripped);
  check("a book with only wins is open",
    !circuitBreaker([row({ result: "win", pnl_pct: 1 }), row({ result: "win", pnl_pct: 1 })], NOW).tripped);
}

// ── 接線：閘門只把 enter 變 wait，且在事件禁入之前 ─────────────────
{
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const src = readFileSync(join(__dirname, "..", "lib", "signal-builder.ts"), "utf8");
  const guard = src.indexOf("stopCooldown(symbolJournal");
  const blackout = src.indexOf("數據前禁入 — a hard blackout");
  check("the builder applies the cooldown and breaker", guard > 0 && src.includes("circuitBreaker(bookJournal)"));
  check("before the event blackout, so the reason stays attributable", guard > 0 && guard < blackout);
  check("and only on an enter", /stance === "enter"\) \{\s*const cooldown/.test(src));
}

report("risk guard");

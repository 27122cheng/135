import { check, report } from "./_harness";
import {
  SESSIONS,
  formatCountdown,
  isWeekendClosed,
  sessionState,
} from "@/lib/analysis/sessions";

/**
 * 交易時段 — the clock behind the site-wide strip.
 *
 * It renders on every page, so a hole in the window table (an hour belonging
 * to no session, or to two) would be a hole on every page at once. The
 * coverage check below is the one that matters most.
 */

const at = (iso: string) => new Date(iso);

// ── the windows tile the day exactly once ─────────────────────────
{
  let uncovered: number[] = [];
  let doubled: number[] = [];
  for (let h = 0; h < 24; h++) {
    const matches = SESSIONS.filter((w) =>
      w.startHour <= w.endHour
        ? h >= w.startHour && h < w.endHour
        : h >= w.startHour || h < w.endHour,
    );
    if (matches.length === 0) uncovered.push(h);
    if (matches.length > 1) doubled.push(h);
  }
  check("every hour belongs to a session", uncovered.length === 0, uncovered);
  check("and to exactly one", doubled.length === 0, doubled);
}

// ── which session, and what is next ───────────────────────────────
{
  // Wednesday, so no weekend interference.
  const london = sessionState(at("2026-08-12T08:00:00Z"));
  check("08:00 UTC is the London session", london.current.id === "london", london.current);
  check("with the overlap next", london.next.id === "overlap", london.next);
  check("and a countdown to it", london.minutesToNext === 300, london.minutesToNext);

  check("14:00 UTC is the overlap", sessionState(at("2026-08-12T14:00:00Z")).current.id === "overlap");
  check("17:00 UTC is New York", sessionState(at("2026-08-12T17:00:00Z")).current.id === "us");

  // The one window that exists to be avoided.
  const maintenance = sessionState(at("2026-08-12T21:30:00Z"));
  check("21:30 UTC is the maintenance hour", maintenance.current.id === "maintenance");
  check("and is flagged as thin", maintenance.current.liquidity === "low");

  // Asia wraps midnight — the case a naive range check gets wrong.
  check("23:00 UTC is Asia", sessionState(at("2026-08-12T23:00:00Z")).current.id === "asia");
  check("03:00 UTC is still Asia", sessionState(at("2026-08-12T03:00:00Z")).current.id === "asia");
  const lateAsia = sessionState(at("2026-08-12T23:30:00Z"));
  check("the countdown wraps midnight too",
    lateAsia.next.id === "london" && lateAsia.minutesToNext === 450, lateAsia.minutesToNext);
}

// ── the weekend is not a session ──────────────────────────────────
{
  check("Saturday is closed", isWeekendClosed(at("2026-08-15T12:00:00Z")));
  check("Friday after 21:00 UTC is closed", isWeekendClosed(at("2026-08-14T21:30:00Z")));
  check("Friday at noon is open", !isWeekendClosed(at("2026-08-14T12:00:00Z")));
  check("Sunday before 22:00 UTC is closed", isWeekendClosed(at("2026-08-16T20:00:00Z")));
  check("Sunday at 22:30 UTC is open again", !isWeekendClosed(at("2026-08-16T22:30:00Z")));
  check("the state carries the flag", sessionState(at("2026-08-15T12:00:00Z")).weekendClosed);
}

// ── the countdown text ────────────────────────────────────────────
{
  check("under an hour reads in minutes", formatCountdown(45) === "45 分");
  check("over an hour splits", formatCountdown(200) === "3 小時 20 分");
  check("a garbage value does not render as NaN", formatCountdown(Number.NaN) === "—");
  check("and neither does a negative", formatCountdown(-5) === "—");
}

report("交易時段");

import type { JournalEntry } from "@/types/journal";
import { AUTO_MARKER, PAPER_MARKER } from "./markers";

/**
 * 帳戶層級的兩道閘 — the rules a desk applies to the *book*, not to a setup.
 *
 * Everything else in this system judges one signal at a time: is the
 * structure there, does the backtest pay, did the lab verify the condition.
 * Nothing asked the two questions a risk manager asks before any of that:
 *
 *  1. Did this exact idea just lose? Re-entering the same symbol in the same
 *     direction within a day of a real loss is the revenge trade, mechanised
 *     — the hourly rescan sees the same structure the stop just disproved and
 *     recommends it again. A reversal (the other direction) is not a revenge
 *     trade and is allowed.
 *  2. Is the book bleeding? Three real losses inside a day, or five in a row,
 *     means the system and the market are out of step in a way no single
 *     signal can see. Sizing already shrinks on a streak; it never says stop.
 *     This does — for a bounded time, then trading resumes on its own.
 *
 * Both read the journal's *real* auto-tracked rows only: paper fills are
 * assumed perfect and a paper loss is a measurement, not money. Both are
 * pure so the thresholds can be pinned by tests. Both can only withdraw a
 * recommendation, never create one.
 */

const HOUR_MS = 60 * 60 * 1000;

/** 同商品同方向真實虧損後的冷卻期。一根日線：讓結構有機會真的重建。 */
export const COOLDOWN_HOURS = 24;

/** 一天內的真實虧損筆數達此數即熔斷。 */
export const DAILY_LOSS_LIMIT = 3;
/** 熔斷後多久恢復（自最後一筆虧損起算）。 */
export const DAILY_PAUSE_HOURS = 24;
/** 連續真實虧損達此數即熔斷（不分商品，打平不計、獲利歸零）。 */
export const STREAK_LOSS_LIMIT = 5;
/** 連敗熔斷後多久恢復。 */
export const STREAK_PAUSE_HOURS = 48;

function isRealAuto(e: JournalEntry): boolean {
  const note = e.review_note ?? "";
  return note.includes(AUTO_MARKER) && !note.includes(PAPER_MARKER);
}

function closedAtMs(e: JournalEntry): number {
  const t = Date.parse(e.closed_at);
  return Number.isFinite(t) ? t : NaN;
}

export interface CooldownVerdict {
  active: boolean;
  /** ISO time the cooldown lifts, when active. */
  until: string | null;
  /** The loss that started it, for the card. */
  lastLossAt: string | null;
  note: string | null;
}

/**
 * Whether `symbol` in `direction` lost for real inside the last
 * {@link COOLDOWN_HOURS}. Any real loss counts, not only stop-outs: a
 * structure or thesis exit at a loss means the reason for the trade already
 * failed, and re-entering on the same reason a few hours later is the same
 * mistake with a different name.
 */
export function stopCooldown(
  history: JournalEntry[],
  input: { symbol: string; direction: "long" | "short"; now?: Date },
): CooldownVerdict {
  const now = (input.now ?? new Date()).getTime();
  let newest: JournalEntry | null = null;
  for (const e of history) {
    if (e.symbol !== input.symbol || e.direction !== input.direction) continue;
    if (e.result !== "loss" || !isRealAuto(e)) continue;
    const t = closedAtMs(e);
    if (!Number.isFinite(t) || t > now) continue;
    if (newest === null || t > closedAtMs(newest)) newest = e;
  }
  if (!newest) return { active: false, until: null, lastLossAt: null, note: null };
  const untilMs = closedAtMs(newest) + COOLDOWN_HOURS * HOUR_MS;
  if (untilMs <= now) return { active: false, until: null, lastLossAt: newest.closed_at, note: null };
  const hoursLeft = Math.max(1, Math.ceil((untilMs - now) / HOUR_MS));
  return {
    active: true,
    until: new Date(untilMs).toISOString(),
    lastLossAt: newest.closed_at,
    note:
      `停損後冷卻：${input.symbol} ${input.direction === "long" ? "做多" : "做空"}` +
      `在 ${newest.closed_at.slice(5, 16).replace("T", " ")} 才以虧損出場，` +
      `${COOLDOWN_HOURS} 小時內不對同方向重新進場（尚餘約 ${hoursLeft} 小時）`,
  };
}

export interface BreakerVerdict {
  tripped: boolean;
  until: string | null;
  /** Which rule tripped: 日內 or 連敗. Null when not tripped. */
  rule: "daily" | "streak" | null;
  note: string | null;
}

/**
 * The book-wide circuit breaker. Reads every real auto-tracked resolution,
 * newest-first or not — order is derived from `closed_at` here.
 */
export function circuitBreaker(history: JournalEntry[], now: Date = new Date()): BreakerVerdict {
  const nowMs = now.getTime();
  const real = history
    .filter((e) => isRealAuto(e) && Number.isFinite(closedAtMs(e)) && closedAtMs(e) <= nowMs)
    .sort((a, b) => closedAtMs(a) - closedAtMs(b));
  if (real.length === 0) return { tripped: false, until: null, rule: null, note: null };

  // 日內：losses closed inside the trailing 24 hours.
  const dayAgo = nowMs - 24 * HOUR_MS;
  const dayLosses = real.filter((e) => e.result === "loss" && closedAtMs(e) >= dayAgo);
  if (dayLosses.length >= DAILY_LOSS_LIMIT) {
    const last = dayLosses[dayLosses.length - 1];
    const untilMs = closedAtMs(last) + DAILY_PAUSE_HOURS * HOUR_MS;
    if (untilMs > nowMs) {
      return {
        tripped: true,
        until: new Date(untilMs).toISOString(),
        rule: "daily",
        note:
          `帳戶熔斷：24 小時內已有 ${dayLosses.length} 筆真實虧損` +
          `（${dayLosses.map((e) => e.symbol).join("、")}），` +
          `暫停所有新倉至 ${new Date(untilMs).toISOString().slice(5, 16).replace("T", " ")} UTC`,
      };
    }
  }

  // 連敗：consecutive real losses, newest backwards; breakeven is ignored, a
  // win ends the run.
  let streak = 0;
  let lastLoss: JournalEntry | null = null;
  for (let i = real.length - 1; i >= 0; i--) {
    const r = real[i].result;
    if (r === "breakeven") continue;
    if (r === "win") break;
    streak++;
    if (lastLoss === null) lastLoss = real[i];
  }
  if (streak >= STREAK_LOSS_LIMIT && lastLoss) {
    const untilMs = closedAtMs(lastLoss) + STREAK_PAUSE_HOURS * HOUR_MS;
    if (untilMs > nowMs) {
      return {
        tripped: true,
        until: new Date(untilMs).toISOString(),
        rule: "streak",
        note:
          `帳戶熔斷：已連續 ${streak} 筆真實虧損，系統與行情明顯不同步，` +
          `暫停所有新倉至 ${new Date(untilMs).toISOString().slice(5, 16).replace("T", " ")} UTC`,
      };
    }
  }
  return { tripped: false, until: null, rule: null, note: null };
}

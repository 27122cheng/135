/**
 * 交易時段 — the clock a 24-hour market needs instead of an opening bell.
 *
 * A stock system can say "closed" and everyone knows what that means. FX
 * never closes, so "is the market open" is the wrong question; the right one
 * is *which* market is awake, because the same setup behaves differently in
 * each. Tokyo ranges, London picks the day's direction, the London–New York
 * overlap carries the volume, and the late US hours thin out into the daily
 * maintenance window where spreads widen and stops get picked off.
 *
 * Pure arithmetic over UTC — no API, no key, no timezone database. The hours
 * are the conventional session boundaries in UTC, which is what the exchanges
 * themselves drift against only for daylight saving; the half-hour that moves
 * twice a year does not change which session a trader is in.
 */

export type SessionId = "asia" | "london" | "overlap" | "us" | "maintenance";

export interface SessionWindow {
  id: SessionId;
  label: string;
  /** Inclusive UTC hour the window starts. */
  startHour: number;
  /** Exclusive UTC hour it ends. */
  endHour: number;
  /** What a trader should expect from it. */
  note: string;
  /** Rough liquidity, for the strip's colour. */
  liquidity: "high" | "medium" | "low";
}

/**
 * In UTC order, covering the whole day exactly once. Overlap is listed as its
 * own window rather than as "London and New York at the same time" because it
 * behaves like neither: it is the only stretch where a breakout has both
 * continents behind it.
 */
export const SESSIONS: SessionWindow[] = [
  {
    id: "asia",
    label: "亞洲盤",
    startHour: 22,
    endHour: 7,
    note: "日圓與澳幣主場；歐美商品流動性偏低，區間行情居多",
    liquidity: "medium",
  },
  {
    id: "london",
    label: "倫敦盤",
    startHour: 7,
    endHour: 13,
    note: "歐系貨幣流動性進場，一天的方向常在此定調",
    liquidity: "high",
  },
  {
    id: "overlap",
    label: "歐美重疊",
    startHour: 13,
    endHour: 16,
    note: "全日流動性與波動高峰，突破最有跟隨力",
    liquidity: "high",
  },
  {
    id: "us",
    label: "紐約盤",
    startHour: 16,
    endHour: 21,
    note: "倫敦收工後動能遞減，尾盤常見回吐",
    liquidity: "medium",
  },
  {
    id: "maintenance",
    label: "換日維護",
    startHour: 21,
    endHour: 22,
    note: "流動性最薄、點差放大 —— 不宜進場，停損容易被掃",
    liquidity: "low",
  },
];

function inWindow(hour: number, w: SessionWindow): boolean {
  // Asia wraps midnight, so its test is a union rather than a range.
  return w.startHour <= w.endHour
    ? hour >= w.startHour && hour < w.endHour
    : hour >= w.startHour || hour < w.endHour;
}

export interface SessionState {
  current: SessionWindow;
  next: SessionWindow;
  /** Minutes until `next` begins. Always ≥ 0. */
  minutesToNext: number;
  /** True during the weekend close — no session is trading at all. */
  weekendClosed: boolean;
}

/**
 * FX trades from Sunday 22:00 UTC to Friday 21:00 UTC. Outside that there is
 * no session to be in, and saying "亞洲盤" on a Saturday would be a lie the
 * rest of the strip then dresses up with a countdown.
 */
export function isWeekendClosed(now: Date): boolean {
  const day = now.getUTCDay();
  const hour = now.getUTCHours() + now.getUTCMinutes() / 60;
  if (day === 6) return true; // Saturday
  if (day === 5 && hour >= 21) return true; // Friday after the close
  if (day === 0 && hour < 22) return true; // Sunday before the open
  return false;
}

export function sessionState(now: Date): SessionState {
  const hour = now.getUTCHours() + now.getUTCMinutes() / 60;
  const current = SESSIONS.find((w) => inWindow(hour, w)) ?? SESSIONS[0];
  const idx = SESSIONS.indexOf(current);
  const next = SESSIONS[(idx + 1) % SESSIONS.length];

  // Minutes to the next boundary, wrapping midnight.
  let delta = next.startHour - hour;
  if (delta <= 0) delta += 24;
  return {
    current,
    next,
    minutesToNext: Math.round(delta * 60),
    weekendClosed: isWeekendClosed(now),
  };
}

/** "3 小時 20 分" / "45 分" — the strip has no room for a clock face. */
export function formatCountdown(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} 小時 ${m} 分` : `${m} 分`;
}

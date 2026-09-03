import type { BiasItem } from "@/types/signal";

/**
 * 時間與事件因子 — the calendar effects a chart cannot see.
 *
 * Everything here is **deterministic**: derivable from the clock alone or
 * from a schedule published far in advance, with no API and no key. NFP is
 * always the first Friday's 12:30 UTC; the London and New York opens are
 * fixed; the futures maintenance hour and the weekend are fixed; month-end is
 * arithmetic; FOMC meeting dates are announced by the Fed more than a year
 * ahead (see FOMC_2026_DECISIONS). CPI dates and earnings are *not* reliably
 * derivable — they come from the Finnhub calendar when a key is set and from
 * the release table after the fact (lib/analysis/data-release.ts), and this
 * module does not guess at them: a wrong "CPI today" would be worse than none.
 *
 * Everything ships at weight 0 — readings, not votes. "It is NFP day" does
 * not know which way the number lands, so it cannot vote a direction; what it
 * does is (a) show on the card where the reader looks for context, and
 * (b) raise the deterministic high-impact flag that the S4 intervention
 * (data-event downgrade) consumes, which used to be blind whenever no
 * Finnhub key was configured.
 */

export interface TimingResult {
  items: BiasItem[];
  /** True within 24h before (or 2h after) a deterministic high-impact release. */
  highImpactWithin24h: boolean;
}

/** First Friday of the month containing `d`, at 12:30 UTC (08:30 ET). */
export function nfpTimeFor(year: number, monthIndex: number): Date {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const day = first.getUTCDay();
  const firstFriday = 1 + ((5 - day + 7) % 7);
  return new Date(Date.UTC(year, monthIndex, firstFriday, 12, 30));
}

function nextNfp(now: Date): Date {
  const thisMonth = nfpTimeFor(now.getUTCFullYear(), now.getUTCMonth());
  if (thisMonth.getTime() >= now.getTime()) return thisMonth;
  return nfpTimeFor(now.getUTCFullYear(), now.getUTCMonth() + 1);
}

/**
 * FOMC 2026 decision days — the second day of each scheduled meeting, from
 * the Fed's published calendar. This is the one exception to "clock-derived
 * only": the schedule is announced more than a year ahead and does not move
 * (an unscheduled emergency meeting is exactly the kind of event no calendar
 * can gate). The statement lands at 14:00 ET — 18:00 UTC during US daylight
 * saving, 19:00 UTC otherwise — and the same before/after window NFP gets
 * applies. CPI is deliberately NOT hard-coded: BLS dates wobble within the
 * month, and a wrong "CPI today" is worse than none; those prints reach the
 * analysis through the release table when they land.
 */
const FOMC_2026_DECISIONS: ReadonlyArray<{ date: string; utcHour: number }> = [
  { date: "2026-01-28", utcHour: 19 },
  { date: "2026-03-18", utcHour: 18 },
  { date: "2026-04-29", utcHour: 18 },
  { date: "2026-06-17", utcHour: 18 },
  { date: "2026-07-29", utcHour: 18 },
  { date: "2026-09-16", utcHour: 18 },
  { date: "2026-10-28", utcHour: 18 },
  { date: "2026-12-09", utcHour: 19 },
];

/**
 * 數據前禁入窗 — how close a clock-derivable release may be before new entries
 * are refused outright. Shared by the signal builder's hard blackout and the
 * monitor's held-position warning, so "don't open" and "consider reducing"
 * always describe the same window. Two hours: pre-positioning and spread
 * widening start inside it, and no technical setup's edge was measured on
 * those bars.
 */
export const EVENT_BLACKOUT_MS = 2 * 60 * 60 * 1000;

/**
 * The next clock-derivable high-impact release inside `horizonMs`, or null.
 *
 * For the monitor's pre-event warning on *held* positions. The S4 intervention
 * already downgrades new signals ahead of these releases; nothing was telling
 * the person already in a trade. Only NFP and FOMC qualify — the two whose
 * schedule is arithmetic — for the same reason the countdown card lists only
 * those two: a wrong "CPI in 2 hours" is worse than none.
 */
export function upcomingHighImpactEvent(
  now: Date,
  horizonMs: number,
): { label: string; at: Date; minutesAway: number } | null {
  const candidates: Array<{ label: string; at: Date }> = [];
  const thisMonth = nfpTimeFor(now.getUTCFullYear(), now.getUTCMonth());
  const nfp =
    thisMonth.getTime() >= now.getTime()
      ? thisMonth
      : nfpTimeFor(now.getUTCFullYear(), now.getUTCMonth() + 1);
  candidates.push({ label: "美國非農就業（NFP）", at: nfp });
  for (const at of fomcTimes()) {
    if (at.getTime() >= now.getTime()) {
      candidates.push({ label: "FOMC 利率決策", at });
      break;
    }
  }
  const within = candidates
    .filter((c) => c.at.getTime() - now.getTime() <= horizonMs && c.at.getTime() > now.getTime())
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  if (within.length === 0) return null;
  const first = within[0];
  return {
    ...first,
    minutesAway: Math.round((first.at.getTime() - now.getTime()) / 60000),
  };
}

/**
 * The clock-derivable high-impact releases that landed inside [from, to].
 *
 * For the stop-loss review. `eventDuringHold` was a parameter the monitor
 * always passed as `false` with a comment promising to fill it in later, so
 * S4（事件衝擊）could never be assigned by the rules — every stop that a
 * release caused was filed as S1（方向錯）or S2, and the intervention engine
 * then tightened direction or entry rules for a loss that neither could have
 * prevented. Misclassified losses teach the wrong lesson; this is the fact
 * the classifier needed. Same two releases as the countdown, for the same
 * reason: a wrong "CPI landed" is worse than none.
 */
export function highImpactEventsBetween(from: Date, to: Date): Array<{ label: string; at: Date }> {
  if (!(to.getTime() > from.getTime())) return [];
  const out: Array<{ label: string; at: Date }> = [];
  // Every NFP whose month touches the window; nfpTimeFor handles overflow.
  const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  for (let m = 0; m < 14; m++) {
    const at = nfpTimeFor(start.getUTCFullYear(), start.getUTCMonth() + m);
    if (at.getTime() > to.getTime()) break;
    if (at.getTime() >= from.getTime()) out.push({ label: "美國非農就業（NFP）", at });
  }
  for (const at of fomcTimes()) {
    if (at.getTime() >= from.getTime() && at.getTime() <= to.getTime()) {
      out.push({ label: "FOMC 利率決策", at });
    }
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

export function fomcTimes(): Date[] {
  return FOMC_2026_DECISIONS.map(
    (m) => new Date(`${m.date}T${String(m.utcHour).padStart(2, "0")}:00:00Z`),
  );
}

/** Last weekday (Mon–Fri) of the month containing `d`. */
export function lastBusinessDay(year: number, monthIndex: number): number {
  const last = new Date(Date.UTC(year, monthIndex + 1, 0));
  let day = last.getUTCDate();
  let dow = last.getUTCDay();
  while (dow === 0 || dow === 6) {
    day -= 1;
    dow = (dow + 6) % 7;
  }
  return day;
}

const item = (
  factor: string,
  evidence: string,
  key: string,
): BiasItem => ({
  dimension: "基本面",
  factor,
  direction: "neutral",
  weight: 0,
  evidence,
  source: "時間因子（UTC 時鐘推導，非 API）",
  key,
});

export function analyzeTiming(now: Date): TimingResult {
  const items: BiasItem[] = [];
  let highImpact = false;

  const hour = now.getUTCHours() + now.getUTCMinutes() / 60;
  const dow = now.getUTCDay();

  // ── NFP：每月第一個週五 12:30 UTC ─────────────────────────────────
  const nfp = nextNfp(now);
  const hoursToNfp = (nfp.getTime() - now.getTime()) / 3_600_000;
  const lastNfp = nfpTimeFor(now.getUTCFullYear(), now.getUTCMonth());
  const hoursSinceNfp = (now.getTime() - lastNfp.getTime()) / 3_600_000;
  if (hoursToNfp >= 0 && hoursToNfp <= 24) {
    highImpact = true;
    items.push(
      item(
        `⚠ NFP（美國非農就業）約 ${Math.round(hoursToNfp)} 小時後公布（每月第一個週五 12:30 UTC）`,
        `公布前波動通常收斂、公布後 1–2 小時劇烈，掛單易被插針掃損`,
        "timing-nfp",
      ),
    );
  } else if (hoursSinceNfp >= 0 && hoursSinceNfp <= 2) {
    highImpact = true;
    items.push(
      item(
        `⚠ NFP 剛公布（${Math.round(hoursSinceNfp * 60)} 分鐘前），仍在高波動時段`,
        `公布後首兩小時常見方向反覆，突破的可信度低於平時`,
        "timing-nfp",
      ),
    );
  }

  // ── FOMC：公告日期表（美聯儲提前一年公布）─────────────────────────
  for (const decision of fomcTimes()) {
    const hoursTo = (decision.getTime() - now.getTime()) / 3_600_000;
    if (hoursTo >= 0 && hoursTo <= 24) {
      highImpact = true;
      items.push(
        item(
          `⚠ FOMC 利率決策約 ${Math.round(hoursTo)} 小時後公布（14:00 ET）`,
          `決策聲明與記者會是全年波動最大的時段之一，方向常在半小時內反覆兩次；掛單易被雙向掃損`,
          "timing-fomc",
        ),
      );
      break;
    }
    const hoursSince = -hoursTo;
    if (hoursSince >= 0 && hoursSince <= 3) {
      highImpact = true;
      items.push(
        item(
          `⚠ FOMC 決策剛公布（${Math.round(hoursSince * 60)} 分鐘前），記者會波動時段`,
          `聲明後 30 分鐘的第一個方向常被記者會反轉，突破可信度低於平時`,
          "timing-fomc",
        ),
      );
      break;
    }
  }

  // ── 交易時段 ─────────────────────────────────────────────────────
  const session =
    hour >= 7 && hour < 8
      ? { label: "倫敦開盤時段（07:00–08:00 UTC）", note: "歐系商品流動性進場，趨勢日常在此定調" }
      : hour >= 13.5 && hour < 16
        ? { label: "紐約開盤／歐美重疊時段（13:30–16:00 UTC）", note: "全日流動性與波動高峰，突破最有跟隨" }
        : hour >= 21 && hour < 22
          ? { label: "期貨結算／換日維護時段（21:00–22:00 UTC）", note: "流動性最薄、點差放大，不宜進場，停損易被掃" }
          : hour >= 22 || hour < 7
            ? { label: "亞洲時段（22:00–07:00 UTC）", note: "美歐商品流動性偏低，區間行情居多" }
            : { label: "歐洲盤中（08:00–13:30 UTC）", note: "流動性正常" };
  items.push(item(`現在為${session.label}`, session.note, "timing-session"));

  // ── 週五尾盤：週末跳空風險 ────────────────────────────────────────
  if (dow === 5 && hour >= 18) {
    items.push(
      item(
        "⚠ 週五尾盤（18:00 UTC 後）：持倉過週末有跳空風險",
        "週末消息無法交易，週一開盤跳空可能直接越過停損價；當沖部位應於收盤前了結",
        "timing-weekend",
      ),
    );
  }

  // ── 月底最後一個交易日：再平衡資金流 ──────────────────────────────
  if (now.getUTCDate() === lastBusinessDay(now.getUTCFullYear(), now.getUTCMonth())) {
    items.push(
      item(
        "今天是月底最後一個交易日",
        "月底基金再平衡的資金流常與趨勢無關，尾盤方向的參考價值低於平時",
        "timing-monthend",
      ),
    );
  }

  return { items, highImpactWithin24h: highImpact };
}

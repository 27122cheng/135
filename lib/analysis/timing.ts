import type { BiasItem } from "@/types/signal";

/**
 * 時間與事件因子 — the calendar effects a chart cannot see.
 *
 * Everything here is **deterministic**: derivable from the clock alone, with
 * no API and no key. That is the boundary on purpose. NFP is always the first
 * Friday's 12:30 UTC; the London and New York opens are fixed; the futures
 * maintenance hour and the weekend are fixed; month-end is arithmetic. FOMC
 * decision dates, CPI dates and earnings are *not* derivable — they come from
 * the Finnhub calendar when a key is set and from the release table after the
 * fact (lib/analysis/data-release.ts), and this module does not guess at
 * them: a wrong "FOMC today" would be worse than none.
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

import type { SignalStore } from "@/lib/db";
import { usableJournal } from "@/lib/journal/quarantine";
import { buildDailyReport, dayIn, reportText } from "@/lib/journal/daily-report";
import { allInstruments } from "@/lib/server-symbols";
import { notifyAll } from "./index";

/**
 * 日報推送 — the previous Taipei trading day's report, once, after 07:00
 * Taipei (23:00 UTC), and only when that day settled at least one real
 * trade. Same mark-before-send discipline as the weekly digest: a marker
 * that fails to persist must not replay the report every five minutes.
 */

const MARKER_KEY = "DAILY_REPORT_SENT_DAY";
const TZ = "Asia/Taipei";

/** The Taipei day the report covers at `now`, or null outside the send window. */
export function reportDayFor(now: Date): string | null {
  const todayTaipei = dayIn(now.toISOString(), TZ);
  // After 07:00 Taipei (any time until the next 07:00) report yesterday Taipei.
  const taipeiHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hour12: false }).format(now)) % 24;
  if (taipeiHour < 7) return null;
  const y = new Date(`${todayTaipei}T00:00:00Z`);
  y.setUTCDate(y.getUTCDate() - 1);
  return y.toISOString().slice(0, 10);
}

export async function maybeSendDailyReport(
  store: SignalStore,
  appUrl: string,
  now = new Date(),
): Promise<{ sent: boolean; reason: string }> {
  const day = reportDayFor(now);
  if (!day) return { sent: false, reason: "不在發送時窗（台北 07:00 後）" };
  const settings = await store.listSettings().catch(() => new Map<string, string>());
  if (settings.get(MARKER_KEY) === day) return { sent: false, reason: "今日已發送" };

  const entries = usableJournal(await store.listJournal({ limit: 2000 }).catch(() => []));
  const roster = await allInstruments().catch(() => []);
  const report = buildDailyReport(entries, { date: day, range: "day", tz: TZ, labels: Object.fromEntries(roster.map((m) => [m.symbol, m.label])) });
  // Mark first, even for an empty day: an empty day is decided once.
  await store.saveSetting(MARKER_KEY, day);
  if (report.summary.trades === 0) return { sent: false, reason: `${day} 無結算，不發日報` };
  const text = reportText(report) + (appUrl ? `\n${appUrl}/report?date=${day}` : "");
  await notifyAll(text);
  return { sent: true, reason: `已發送 ${day} 日報（${report.summary.trades} 筆）` };
}

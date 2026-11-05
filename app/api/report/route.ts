import { getSignalStore } from "@/lib/db";
import { usableJournal } from "@/lib/journal/quarantine";
import { buildDailyReport, dayIn, reportText, type ReportRange } from "@/lib/journal/daily-report";
import { reportSvg } from "@/lib/journal/report-svg";
import { allInstruments } from "@/lib/server-symbols";
import { json } from "@/lib/json-response";

export const dynamic = "force-dynamic";

/**
 * 盤中策略與交易紀錄 — ?date=YYYY-MM-DD&range=day|week|month
 * ?format=svg returns the image; ?format=text the Telegram text.
 */
export async function GET(request: Request) {
  const store = getSignalStore();
  if (!store) {
    return json({ error: "未設定資料庫（DATABASE_URL 或 Supabase），交易日誌與日報無法使用" }, { status: 501 });
  }
  const url = new URL(request.url);
  const tz = "Asia/Taipei";
  const date = url.searchParams.get("date") || dayIn(new Date().toISOString(), tz);
  const rangeParam = url.searchParams.get("range");
  const range: ReportRange = rangeParam === "week" || rangeParam === "month" ? rangeParam : "day";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "date 必須是 YYYY-MM-DD" }, { status: 400 });
  try {
    const [entries, roster] = await Promise.all([
      store.listJournal({ limit: 2000 }),
      allInstruments().catch(() => []),
    ]);
    const labels = Object.fromEntries(roster.map((m) => [m.symbol, m.label]));
    const report = buildDailyReport(usableJournal(entries), { date, range, tz, labels });
    const format = url.searchParams.get("format");
    if (format === "svg") {
      return new Response(reportSvg(report), {
        headers: {
          "content-type": "image/svg+xml; charset=utf-8",
          "content-disposition": `inline; filename="report-${report.from}${range === "day" ? "" : `-${range}`}.svg"`,
          "cache-control": "no-store",
        },
      });
    }
    if (format === "text") return json({ text: reportText(report) });
    return json(report);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "產生日報失敗" }, { status: 502 });
  }
}

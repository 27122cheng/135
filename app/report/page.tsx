"use client";

import { useCallback, useEffect, useState } from "react";
import { SiteNav } from "@/components/site-nav";
import type { DailyReport, ReportRange } from "@/lib/journal/daily-report";

/**
 * 日報 — the trading-room report: a date, four numbers, points per
 * instrument, every settled trade. Download as an image, or copy the text
 * for Telegram.
 */

function todayTaipei(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const RANGE_LABEL: Record<ReportRange, string> = { day: "日", week: "週", month: "月" };

export default function ReportPage() {
  const [date, setDate] = useState(todayTaipei);
  const [range, setRange] = useState<ReportRange>("day");
  const [report, setReport] = useState<DailyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/report?date=${date}&range=${range}`, { cache: "no-store" });
      const body = (await res.json()) as DailyReport & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setReport(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [date, range]);
  useEffect(() => {
    void load();
  }, [load]);

  async function copyText() {
    try {
      const res = await fetch(`/api/report?date=${date}&range=${range}&format=text`);
      const { text } = (await res.json()) as { text: string };
      await navigator.clipboard.writeText(text.replace(/<\/?[bi]>/g, ""));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked: the SVG link still works
    }
  }

  const s = report?.summary;
  const real = report?.rows.filter((r) => !r.paper) ?? [];
  const paper = report?.rows.filter((r) => r.paper) ?? [];
  const period = report ? (report.range === "day" ? report.from : `${report.from} ～ ${report.to}`) : date;

  return (
    <main className="mx-auto max-w-2xl px-4 py-5">
      <SiteNav title="盤中策略與交易紀錄" />
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded-lg border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-200" />
        {(["day", "week", "month"] as ReportRange[]).map((r) => (
          <button key={r} type="button" onClick={() => setRange(r)} className={`rounded-full px-3 py-1 ${range === r ? "bg-neutral-100 text-neutral-900" : "bg-neutral-800 text-neutral-400"}`}>
            {RANGE_LABEL[r]}報
          </button>
        ))}
        <span className="ml-auto flex gap-1.5">
          <a href={`/api/report?date=${date}&range=${range}&format=svg`} download className="rounded-lg border border-neutral-700 px-2.5 py-1 text-neutral-200 hover:bg-neutral-800">
            ↓ 下載圖片
          </a>
          <button type="button" onClick={() => void copyText()} className="rounded-lg border border-neutral-700 px-2.5 py-1 text-neutral-200 hover:bg-neutral-800">
            {copied ? "已複製" : "複製文字"}
          </button>
        </span>
      </div>

      {loading && <p className="py-8 text-center text-sm text-neutral-500">載入中…</p>}
      {error && <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300">{error}</p>}

      {report && s && !loading && (
        <div className="overflow-hidden rounded-xl border border-[#2a2a2e] bg-[#0b0f16]">
          <div className="flex items-center gap-3 bg-[#111827] px-4 py-3">
            <span className="rounded bg-[#d4a84b] px-2 py-0.5 text-sm font-bold text-[#0b0f16]">{period}</span>
            <span className="text-base font-bold text-neutral-100">盤中策略與交易紀錄</span>
            <span className="ml-auto text-[10px] text-neutral-500">正式訊號，監控自動結算</span>
          </div>
          <div className="p-4">
            <p className="mb-2 text-sm font-medium text-neutral-200">{RANGE_LABEL[report.range] === "日" ? "今日" : `本${RANGE_LABEL[report.range]}`}策略表現摘要</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Tile label="有效記錄" value={`${s.trades} 筆`} tone="text-neutral-100" />
              <Tile label="勝率" value={s.winRate === null ? "—" : `${s.winRate}%`} sub={s.winRate === null ? "" : `95% 區間 ${s.winRateLow}–${s.winRateHigh}%`} tone="text-red-300" />
              <Tile label="盈虧比" value={s.profitFactor === null ? "—" : `${s.profitFactor}:1`} sub={`淨 ${s.netPct > 0 ? "+" : ""}${s.netPct}%`} tone="text-[#d4a84b]" />
              <Tile label="最大回撤" value={`${s.maxDrawdownPct}%`} sub="期內權益曲線" tone="text-emerald-300" />
            </div>
            <p className="mt-2 text-[11px] text-neutral-500">
              歷史參考　勝率 {report.historical.winRate ?? "—"}%　｜　盈虧比 {report.historical.profitFactor ?? "—"}　｜　最大回撤 {report.historical.maxDrawdownPct}%（{report.historical.trades} 筆）
            </p>

            <div className="mt-4 flex items-baseline justify-between">
              <p className="text-sm font-medium text-neutral-200">所選商品完整點數</p>
              <p className="text-[10px] text-neutral-500">進出場價差，各商品單位不同，不代表實際收益</p>
            </div>
            {report.bySymbol.length === 0 ? (
              <p className="mt-1 text-[12px] text-neutral-500">本期沒有結算的正式訊號。</p>
            ) : (
              <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] sm:grid-cols-3">
                {report.bySymbol.map((b) => (
                  <div key={b.symbol} className="flex justify-between gap-2">
                    <span className="text-neutral-300">{b.label}</span>
                    <span className="tabular-nums">
                      <span className="text-red-300">盈 {b.winPoints}</span>
                      <span className="text-neutral-600"> · </span>
                      <span className="text-emerald-300">損 {Math.abs(b.lossPoints)}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-4 flex items-baseline justify-between">
              <p className="text-sm font-medium text-neutral-200">完整交易明細</p>
              <p className="text-[10px] text-neutral-500">方向、進出場與單筆結果清楚保留</p>
            </div>
            <div className="mt-1 overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead className="bg-[#1f2a3a] text-[#d4a84b]">
                  <tr>
                    {["商品", "方向", "進場", "出場", "點數", "％", "出場方式"].map((h) => (
                      <th key={h} className="whitespace-nowrap px-2 py-1.5 text-left font-normal">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {real.map((r, i) => (
                    <tr key={`${r.symbol}-${r.closedAt}-${i}`} className={i % 2 ? "bg-[#0d1420]" : "bg-[#0a0f18]"}>
                      <td className="whitespace-nowrap px-2 py-1 text-neutral-200">{r.label}</td>
                      <td className={`px-2 py-1 ${r.direction === "long" ? "text-red-300" : "text-emerald-300"}`}>{r.direction === "long" ? "多" : "空"}</td>
                      <td className="px-2 py-1 tabular-nums text-neutral-200">{r.entry}</td>
                      <td className="px-2 py-1 tabular-nums text-neutral-200">{r.exit}</td>
                      <td className={`px-2 py-1 tabular-nums ${r.points > 0 ? "text-red-300" : "text-emerald-300"}`}>{r.points > 0 ? "+" : ""}{r.points}</td>
                      <td className={`px-2 py-1 tabular-nums ${r.pnlPct >= 0 ? "text-red-300" : "text-emerald-300"}`}>{r.pnlPct > 0 ? "+" : ""}{r.pnlPct}%</td>
                      <td className="whitespace-nowrap px-2 py-1 text-neutral-500">{r.exitKind}</td>
                    </tr>
                  ))}
                  {real.length === 0 && (
                    <tr><td colSpan={7} className="px-2 py-3 text-center text-neutral-500">本期沒有結算的正式訊號。</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {paper.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] text-neutral-500">參考價位紙上追蹤 {paper.length} 筆（不計入摘要）</summary>
                <ul className="mt-1 text-[11px] text-neutral-500">
                  {paper.map((r, i) => (
                    <li key={`p-${i}`}>{r.label} {r.direction === "long" ? "多" : "空"} {r.entry} → {r.exit}（{r.pnlPct > 0 ? "+" : ""}{r.pnlPct}%）{r.exitKind}</li>
                  ))}
                </ul>
              </details>
            )}
            <ul className="mt-4 space-y-0.5 border-t border-neutral-800 pt-3 text-[10px] text-neutral-500">
              {report.notes.map((n) => <li key={n}>{n}</li>)}
            </ul>
          </div>
        </div>
      )}
    </main>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: string }) {
  return (
    <div className="rounded-lg border border-[#1f2a3a] bg-[#101826] px-3 py-2 text-center">
      <p className="text-[11px] text-neutral-500">{label}</p>
      <p className={`text-xl font-bold tabular-nums ${tone}`}>{value}</p>
      {sub ? <p className="text-[10px] text-neutral-500">{sub}</p> : null}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { COMMODITIES } from "@/types/signal";
import { loadCustomSymbols } from "@/lib/custom-symbols";
import type { Grade, SignalRow } from "@/types/signal";
import { GradeBadge } from "@/components/grade-badge";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SiteNav } from "@/components/site-nav";

const GRADES: Grade[] = ["A+", "A", "B", "C", "no-trade"];

/**
 * The reason a grade was forced down, if one was.
 *
 * `gradeSignal` is pure arithmetic, so a total of 14 grading no-trade always
 * means something after it overrode the result — no stop structure, no target,
 * or an S2 intervention. Each writes a data_gap saying so; this finds it.
 */
function disqualifier(row: SignalRow): string | null {
  const gaps = Array.isArray(row.data_gaps) ? (row.data_gaps as string[]) : [];
  return gaps.find((g) => g.includes("強制降級") || g.includes("降為 no-trade")) ?? null;
}

export default function HistoryPage() {
  const [symbol, setSymbol] = useState("");
  // 全部標的，含自訂 —— the picker listed COMMODITIES alone, so a BTC/ETH
  // row could be scanned, settled and journalled and still be unselectable
  // here. Read on mount like every other client roster (see app/page.tsx).
  const [roster, setRoster] = useState<{ symbol: string; label: string }[]>(
    () => COMMODITIES.map((c) => ({ symbol: c.symbol, label: c.label })),
  );
  useEffect(() => {
    setRoster([
      ...COMMODITIES.map((c) => ({ symbol: c.symbol, label: c.label })),
      ...loadCustomSymbols().map((c) => ({ symbol: c.symbol, label: c.label })),
    ]);
  }, []);

  const [grade, setGrade] = useState("");
  // Defaults on: the question this page usually answers is "what did it
  // actually recommend", and a scan that stood aside is noise against that.
  // The scans are all still stored — this hides them, it does not skip them.
  const [tradeableOnly, setTradeableOnly] = useState(true);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rows, setRows] = useState<SignalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (symbol) params.set("symbol", symbol);
    if (grade) params.set("grade", grade);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    // Server-side, not filtered after the fetch. The client version pulled the
    // newest 50 rows and filtered those, and once the auto-scan was appending
    // dozens of 觀望 rows a day, every 進場 row sat past row 50 — the page
    // said "全部是觀望" forever while Telegram announced trades living in the
    // same table.
    if (tradeableOnly) params.set("stance", "enter");
    fetch(`/api/history?${params.toString()}`, { cache: "no-store" })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        return data.rows as SignalRow[];
      })
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, grade, from, to, tradeableOnly]);

  const visible = rows;

  return (
    <main className="mx-auto max-w-2xl px-4 py-5">
      <SiteNav title="歷史訊號" />

      <div className="mb-4 flex flex-wrap gap-3 rounded-lg border border-neutral-800 bg-neutral-900/60 p-3 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-neutral-500">商品</span>
          <select
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1"
          >
            <option value="">全部</option>
            {roster.map((c) => (
              <option key={c.symbol} value={c.symbol}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-neutral-500">等級</span>
          <select
            value={grade}
            onChange={(e) => setGrade(e.target.value)}
            className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1"
          >
            <option value="">全部</option>
            {GRADES.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-neutral-500">從</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1"
          />
        </label>
        <label className="flex items-center gap-2">
          <span className="text-neutral-500">到</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1"
          />
        </label>
      </div>

      {loading && <p className="text-sm text-neutral-500">載入中…</p>}
      {error && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300">
          {error}
          {error.includes("Supabase") && (
            <span className="mt-1 block text-xs text-amber-400/80">
              請先套用 supabase/schema.sql 並設定 NEXT_PUBLIC_SUPABASE_URL /
              NEXT_PUBLIC_SUPABASE_ANON_KEY，且需有 Vercel Cron 執行過 /api/cron/refresh-signals
              才會有歷史資料。
            </span>
          )}
        </p>
      )}
      <label className="mb-3 flex cursor-pointer items-center gap-2 text-xs text-neutral-500">
        <input
          type="checkbox"
          checked={tradeableOnly}
          onChange={(e) => setTradeableOnly(e.target.checked)}
          className="h-3 w-3 accent-emerald-500"
        />
        只看建議進場的
      </label>

      {!loading && !error && visible.length === 0 && (
        <p className="text-sm text-neutral-500">
          {tradeableOnly
            ? "整個資料庫裡沒有任何一筆建議進場的歷史訊號（不只是最近幾筆）。取消上面的勾選可以看觀望紀錄。"
            : "尚無符合條件的歷史訊號。"}
        </p>
      )}

      {!loading && !error && visible.length > 0 && (
        <ul className="flex flex-col gap-2">
          {visible.map((r) => (
            <li key={r.id} className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="font-medium text-neutral-100">{r.symbol}</span>
                  <span
                    className={cn(
                      "ml-2 text-sm",
                      r.direction_tie
                        ? "text-neutral-400"
                        : r.direction === "long"
                          ? "text-emerald-400"
                          : "text-red-400",
                    )}
                  >
                    {r.direction_tie ? "中性" : r.direction === "long" ? "做多" : "做空"}
                  </span>
                  <span className="ml-2 text-xs text-neutral-500">
                    {formatTime(r.generated_at)}
                  </span>
                </div>
                <GradeBadge grade={r.grade} />
              </div>
              <p className="mt-1.5 text-xs text-neutral-500">
                方向分 <span className="font-mono text-neutral-400">{r.bias_score}</span>
                <span className="mx-1.5 text-neutral-700">+</span>
                結構分 <span className="font-mono text-neutral-400">{r.entry_structure_score}</span>
                <span className="mx-1.5 text-neutral-700">=</span>
                總分 <span className="font-mono text-neutral-300">{r.total_score}</span>
              </p>
              {/* A 14-point signal graded no-trade looks like a bug unless the
                  override says so. The disqualifiers write a data_gap when they
                  fire; surfacing it here is the difference between "the scoring
                  is broken" and "there was no structure to anchor a stop to". */}
              {disqualifier(r) && (
                <p className="mt-1.5 text-xs leading-relaxed text-amber-500/80">
                  {disqualifier(r)}
                </p>
              )}
              <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-neutral-500">
                {r.narrative}
              </p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

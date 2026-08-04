"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { COMMODITIES } from "@/types/signal";
import type { Grade, SignalRow } from "@/types/signal";
import { GradeBadge } from "@/components/grade-badge";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const GRADES: Grade[] = ["A+", "A", "B", "C", "no-trade"];

export default function HistoryPage() {
  const [symbol, setSymbol] = useState("");
  const [grade, setGrade] = useState("");
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
    fetch(`/api/history?${params.toString()}`)
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
  }, [symbol, grade, from, to]);

  return (
    <main className="mx-auto max-w-2xl px-4 py-5">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-bold text-neutral-100">歷史訊號</h1>
        <Link href="/" className="text-sm text-neutral-400 hover:underline">
          ← 回到即時訊號
        </Link>
      </div>

      <div className="mb-4 flex flex-wrap gap-3 rounded-lg border border-neutral-800 bg-neutral-900/60 p-3 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-neutral-500">商品</span>
          <select
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1"
          >
            <option value="">全部</option>
            {COMMODITIES.map((c) => (
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
      {!loading && !error && rows.length === 0 && (
        <p className="text-sm text-neutral-500">尚無符合條件的歷史訊號。</p>
      )}

      {!loading && !error && rows.length > 0 && (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li key={r.id} className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="font-medium text-neutral-100">{r.symbol}</span>
                  <span
                    className={cn(
                      "ml-2 text-sm",
                      r.direction === "long" ? "text-emerald-400" : "text-red-400",
                    )}
                  >
                    {r.direction === "long" ? "做多" : "做空"}
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

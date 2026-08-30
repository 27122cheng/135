"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { BoardRow } from "@/app/api/board/route";
import type { CorrelationReport } from "@/lib/analysis/correlation";
import { COMMODITIES } from "@/types/signal";
import { loadCustomSymbols } from "@/lib/custom-symbols";
import { SiteNav } from "@/components/site-nav";

/**
 * 商品排名 — sorted by how good the *market* is, not by how good the signal is.
 *
 * 交易總覽 answers "is there anything to do right now", which is a yes/no per
 * instrument and sorts by grade. That is the wrong order for the other
 * question a session starts with: where is the cleanest trend, whatever the
 * entry rules currently say. A B-grade in a clean, weekly-aligned trend is a
 * better place to be waiting than an A in a round trip, and the board's
 * ordering actively hides that.
 *
 * So this ranks on trend quality (efficiency ratio × structure × weekly
 * agreement), tabs by instrument class, and keeps grade as a column rather
 * than as the sort key.
 */

interface BoardResponse {
  rows?: BoardRow[];
  error?: string;
  next?: string;
}

/**
 * A custom symbol's own label, not its bare id. The board serves BTC/ETH rows
 * through the roster, but this lookup only knew the nine built-ins, so those
 * rows rendered as 「BTCUSD」 while every other row showed a real name.
 */
function labelOf(symbol: string): string {
  const builtin = COMMODITIES.find((c) => c.symbol === symbol);
  if (builtin) return builtin.label;
  return loadCustomSymbols().find((c) => c.symbol === symbol)?.label ?? symbol;
}

const CATEGORIES: { id: string; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "forex", label: "貨幣" },
  { id: "metal", label: "金屬" },
  { id: "index", label: "指數" },
  { id: "energy", label: "能源" },
];

/**
 * 0–100, from the three things that make a trend tradeable: how straight the
 * path has been, whether the daily structure has a direction at all, and
 * whether the week agrees. Deliberately *not* the grade — the grade already
 * has a column, and folding it in here would make this a second grade with a
 * different name.
 */
function trendScore(row: BoardRow): number | null {
  if (row.trendEfficiency === null && row.trendPhase === null) return null;
  const er = row.trendEfficiency ?? 0;
  // ER 0.35+ is a real trend; scale so that maps to most of the range.
  const base = Math.min(100, Math.round((er / 0.5) * 70));
  const structure = row.trendPhase === "up" || row.trendPhase === "down" ? 20 : 0;
  const weekly = row.weeklyAligned ? 10 : 0;
  return Math.min(100, base + structure + weekly);
}

function scoreTone(score: number | null): string {
  if (score === null) return "text-neutral-600";
  if (score >= 70) return "text-emerald-400";
  if (score >= 45) return "text-neutral-200";
  return "text-neutral-500";
}

export default function RankingPage() {
  const [rows, setRows] = useState<BoardRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState("all");
  const [correlation, setCorrelation] = useState<{
    report?: CorrelationReport;
    error?: string;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/board", { cache: "no-store" });
      const body: BoardResponse = await res.json();
      setRows(body.rows ?? []);
      setError(res.ok ? null : (body.next ?? body.error ?? "讀取失敗"));
    } catch {
      setError("讀取失敗");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    // Once per visit: correlations are computed over 60 daily sessions, so a
    // one-minute refresh would re-fetch an answer that cannot have changed.
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/correlation", { cache: "no-store" });
        const body = (await res.json()) as { report?: CorrelationReport; error?: string };
        if (!cancelled) setCorrelation(res.ok ? { report: body.report } : { error: body.error ?? "讀取失敗" });
      } catch {
        if (!cancelled) setCorrelation({ error: "相關性讀取失敗" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const ranked = useMemo(() => {
    const filtered = rows.filter((r) => category === "all" || r.category === category);
    return [...filtered].sort((a, b) => (trendScore(b) ?? -1) - (trendScore(a) ?? -1));
  }, [rows, category]);

  // 反轉機會 — the opposite question, on the same data: instruments where the
  // structure has no direction but a false break just fired are where a
  // reversal would start, and a trend-quality sort buries them at the bottom
  // by construction.
  const reversals = useMemo(
    () => rows.filter((r) => r.trendPhase === "mixed" && r.stance === "enter"),
    [rows],
  );

  return (
    <main className="mx-auto max-w-2xl px-4 py-5">
      <SiteNav title="商品排名" />

      <p className="mb-3 text-[11px] leading-relaxed text-neutral-500">
        依<span className="text-neutral-300">趨勢品質</span>排序，不是依評等 ——
        評等回答「現在能不能做」，這裡回答「哪個市場的走勢最乾淨」。
        分數 = 走勢效率（路徑有多直）＋日線結構有方向＋週線同向。
      </p>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setCategory(c.id)}
            className={`rounded-full px-3 py-1 text-xs ${
              category === c.id
                ? "bg-neutral-100 text-neutral-900"
                : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-400">
          {error}
        </div>
      )}

      <div className="mb-5 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] text-neutral-600">
              <th className="py-1 font-normal">商品</th>
              <th className="py-1 text-right font-normal">趨勢品質</th>
              <th className="py-1 text-right font-normal">走勢</th>
              <th className="py-1 text-right font-normal">週線</th>
              <th className="py-1 text-right font-normal">評等</th>
            </tr>
          </thead>
          <tbody>
            {ranked.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-neutral-600">
                  尚無掃描資料
                </td>
              </tr>
            )}
            {ranked.map((r) => {
              const score = trendScore(r);
              return (
                <tr key={r.symbol} className="border-t border-neutral-800">
                  <td className="py-2">
                    <Link href={`/?symbol=${r.symbol}`} className="text-neutral-200 hover:underline">
                      {r.label}
                    </Link>
                  </td>
                  <td className={`py-2 text-right font-mono ${scoreTone(score)}`}>
                    {score ?? "—"}
                  </td>
                  <td className="py-2 text-right">
                    {r.trendPhase === "up" ? (
                      <span className="text-emerald-400">上升</span>
                    ) : r.trendPhase === "down" ? (
                      <span className="text-red-400">下降</span>
                    ) : r.trendPhase === "mixed" ? (
                      <span className="text-neutral-500">盤整</span>
                    ) : (
                      <span className="text-neutral-700">—</span>
                    )}
                    {r.trendEfficiency !== null && (
                      <span className="ml-1 font-mono text-[10px] text-neutral-600">
                        {r.trendEfficiency.toFixed(2)}
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-right text-[11px]">
                    {r.weeklyAligned ? (
                      <span className="text-emerald-500">同向</span>
                    ) : (
                      <span className="text-neutral-600">—</span>
                    )}
                  </td>
                  <td className="py-2 text-right">
                    {r.stance === "enter" ? (
                      <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-400">
                        {r.grade} 可進場
                      </span>
                    ) : (
                      <span className="text-[10px] text-neutral-600">{r.grade ?? "—"} 觀望</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 相關性檢查 — the check this page's nav hint has always promised.
          A ranking sorted by trend quality quietly invites taking the top
          three at once; when two of them correlate at 0.9 that is one trade
          at double size wearing two names, and nothing else on the page can
          see it. */}
      <section className="mb-5">
        <h2 className="mb-2 text-sm font-medium text-neutral-300">相關性檢查</h2>
        {correlation === null ? (
          <p className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-3 text-xs text-neutral-600">
            計算中…（用最近 60 個共同交易日的日報酬）
          </p>
        ) : correlation.error ? (
          <p className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-400">
            {correlation.error}
          </p>
        ) : (
          <>
            {correlation.report!.clusters.length > 0 ? (
              <div className="mb-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
                <p className="mb-1.5 text-xs font-medium text-amber-300">
                  實質上是同一筆交易（|r| ≥ 0.7）
                </p>
                <ul className="flex flex-col gap-1">
                  {correlation.report!.clusters.map((p) => (
                    <li key={`${p.a}-${p.b}`} className="flex items-center gap-2 text-xs">
                      <span className="text-neutral-200">
                        {labelOf(p.a)} ↔ {labelOf(p.b)}
                      </span>
                      <span
                        className={`ml-auto font-mono ${
                          (p.r ?? 0) > 0 ? "text-amber-400" : "text-sky-400"
                        }`}
                      >
                        r = {p.r?.toFixed(2)}
                      </span>
                      <span className="text-[10px] text-neutral-600">n={p.overlap}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-[10px] leading-relaxed text-amber-500/70">
                  同時持有這兩個、方向又對應同一個宏觀觀點時，部位要當一筆來算 ——
                  各下 1% 風險等於對同一個看法下 2%。負相關（藍色）則是反向對沖，同向持有會互相抵消。
                </p>
              </div>
            ) : (
              <p className="mb-2 rounded-xl border border-neutral-800 bg-neutral-900/40 p-3 text-xs text-neutral-600">
                目前沒有任何一組商品的相關性達到 0.7 —— 各商品可以視為獨立部位。
              </p>
            )}

            <details className="rounded-xl border border-neutral-800 bg-neutral-900/40">
              <summary className="cursor-pointer px-3 py-2 text-[11px] text-neutral-500">
                完整矩陣（{correlation.report!.symbols.length} 個商品）
              </summary>
              <div className="overflow-x-auto px-3 pb-3">
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className="py-1 text-left text-[9px] font-normal text-neutral-600"></th>
                      {correlation.report!.symbols.map((s) => (
                        <th key={s} className="px-1 py-1 text-right text-[9px] font-normal text-neutral-600">
                          {s.slice(0, 6)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {correlation.report!.symbols.map((s, i) => (
                      <tr key={s}>
                        <td className="py-0.5 text-[9px] text-neutral-500">{s}</td>
                        {correlation.report!.matrix[i].map((r, j) => (
                          <td
                            key={j}
                            className={`px-1 py-0.5 text-right font-mono text-[10px] ${
                              i === j
                                ? "text-neutral-700"
                                : r === null
                                  ? "text-neutral-700"
                                  : Math.abs(r) >= 0.7
                                    ? r > 0
                                      ? "text-amber-400"
                                      : "text-sky-400"
                                    : Math.abs(r) >= 0.4
                                      ? "text-neutral-300"
                                      : "text-neutral-600"
                            }`}
                          >
                            {i === j ? "—" : r === null ? "·" : r.toFixed(2)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-[10px] leading-relaxed text-neutral-600">
                  {correlation.report!.note}
                </p>
              </div>
            </details>
          </>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-neutral-300">反轉機會</h2>
        <p className="mb-2 text-[11px] leading-relaxed text-neutral-600">
          結構沒有方向、但規則仍給出進場的商品 —— 趨勢排序天生把它們排在最後，
          但反轉正是從這裡開始的。
        </p>
        {reversals.length === 0 ? (
          <p className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-3 text-xs text-neutral-600">
            目前沒有這類機會。
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {reversals.map((r) => (
              <Link
                key={r.symbol}
                href={`/?symbol=${r.symbol}`}
                className="flex items-center gap-2 rounded-lg border border-neutral-800 px-3 py-2 text-xs hover:bg-neutral-900/60"
              >
                <span className="w-24 shrink-0 text-neutral-200">{r.label}</span>
                <span className={r.direction === "long" ? "text-emerald-400" : "text-red-400"}>
                  {r.direction === "long" ? "做多 ▲" : "做空 ▼"}
                </span>
                <span className="ml-auto shrink-0 text-neutral-500">{r.grade}</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

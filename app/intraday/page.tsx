"use client";

import { useCallback, useEffect, useState } from "react";
import { SiteNav } from "@/components/site-nav";
import type { IntradaySweepResult } from "@/lib/intraday/sweep";
import { PROVE_MIN } from "@/lib/intraday/ledger";

/**
 * 日內模式（加密貨幣）— H1 background, M15 pullback, confirm entry, paper
 * ledger. The page says plainly that nothing is pushed until the ledger
 * proves the edge.
 */

const POLL_MS = 60_000;
const fmt = (n: number | null) => (n === null ? "—" : Math.abs(n) < 10 ? n.toFixed(4) : n.toFixed(2));

export default function IntradayPage() {
  const [data, setData] = useState<IntradaySweepResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/intraday", { cache: "no-store" });
      const body = (await res.json()) as IntradaySweepResult & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setData(body);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const stats = data?.stats ?? null;
  return (
    <main className="mx-auto max-w-2xl px-4 py-5">
      <SiteNav title="日內模式（加密貨幣）" />
      <div className={`mb-3 rounded-xl border p-3 text-sm ${stats?.proven ? "border-emerald-500/40 bg-emerald-500/[0.07] text-emerald-300" : "border-amber-500/40 bg-amber-500/[0.07] text-amber-300"}`}>
        {data?.ledger === "none"
          ? "未設定資料庫：只顯示即時判斷，沒有紙上帳本，無法驗證。"
          : stats
            ? stats.note
            : `紙上追蹤中（滿 ${PROVE_MIN} 筆且期望值 > 0 才會開啟通知）`}
        <span className="mt-1 block text-[11px] font-normal text-neutral-400">
          H1 看背景（EMA20 &gt; EMA50 且低點抬升）→ M15 找回踩區（前低或 EMA20）→ 觸及並收回才進 → 停損貼結構外 0.5 ATR → 目標取前方結構（≥1.5R）→ 同一套移停與結構翻轉出場。
          Binance 即時、免金鑰、有成交量；外匯與黃金沒有免費即時資料，所以不做。
        </span>
      </div>

      {loading && <p className="py-8 text-center text-sm text-neutral-500">載入中…</p>}
      {error && <p className="mb-3 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}

      {stats && (
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Tile label="紙上結算" value={`${stats.resolved} / ${PROVE_MIN}`} sub={`持倉中 ${stats.open}`} />
          <Tile label="勝率" value={stats.winRate === null ? "—" : `${stats.winRate}%`} sub={stats.winRate === null ? "" : `95% 區間 ${stats.winRateLow}–${stats.winRateHigh}%`} />
          <Tile label="期望值／筆" value={stats.expectancyR === null ? "—" : `${stats.expectancyR}R`} sub="已扣加密貨幣成本" tone={stats.expectancyR === null ? "" : stats.expectancyR > 0 ? "text-emerald-300" : "text-red-300"} />
          <Tile label="通知" value={stats.proven ? "可開啟" : "未開啟"} sub={stats.proven ? "" : "驗證前不推播"} />
        </div>
      )}

      <div className="flex flex-col gap-3">
        {(data?.signals ?? []).map((s) => {
          const tone = s.stance === "enter" ? "border-emerald-500/40" : s.stance === "wait" ? "border-amber-500/30" : "border-neutral-800";
          return (
            <section key={s.symbol} className={`rounded-xl border ${tone} bg-neutral-900/40 p-3`}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <h2 className="text-sm font-medium text-neutral-100">
                  {s.label} <span className="text-neutral-500">{s.pair}</span>
                  {s.direction && <span className={`ml-2 ${s.direction === "long" ? "text-emerald-300" : "text-red-300"}`}>{s.direction === "long" ? "偏多" : "偏空"}</span>}
                </h2>
                <span className="text-[11px] text-neutral-500">
                  {s.lastClose !== null ? `最新 ${fmt(s.lastClose)}` : ""}
                  {s.barTime ? `・M15 ${s.barTime.slice(5, 16).replace("T", " ")} UTC` : ""}
                </span>
              </div>
              <p className={`mt-1 text-sm ${s.stance === "enter" ? "text-emerald-300" : s.stance === "wait" ? "text-amber-300" : "text-neutral-400"}`}>
                {s.stance === "enter" ? "進場" : s.stance === "wait" ? "等待" : "不做"}：{s.verdict}
              </p>
              <p className="mt-1 text-[11px] text-neutral-500">{s.background}</p>
              {s.zone !== null && (
                <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                  <div><p className="text-neutral-500">回踩區／進場</p><p className="font-mono text-neutral-100">{fmt(s.zone)}{s.entry !== null ? ` → ${fmt(s.entry)}` : ""}</p><p className="text-neutral-500">{s.reasons.entry}</p></div>
                  <div><p className="text-neutral-500">停損</p><p className="font-mono text-red-300">{fmt(s.stop)}</p><p className="text-neutral-500">{s.reasons.stop}</p></div>
                  <div><p className="text-neutral-500">目標</p><p className="font-mono text-emerald-300">{fmt(s.target)}{s.riskReward !== null ? ` (1:${s.riskReward})` : ""}</p><p className="text-neutral-500">{s.reasons.target}</p></div>
                </div>
              )}
              {s.backtest && (
                <p className="mt-1.5 text-[11px] text-neutral-500">
                  M15 回測 {s.backtest.resolved} 筆：勝率 {s.backtest.hitRate === null ? "—" : `${Math.round(s.backtest.hitRate * 100)}%`}，期望值 {s.backtest.expectancyR ?? "—"}R（含成本，確認進場）
                </p>
              )}
              {s.openTrade && (
                <p className="mt-1.5 text-[11px] text-sky-300">
                  紙上持倉：{s.openTrade.direction === "long" ? "多" : "空"} @ {fmt(s.openTrade.entry)}，停損 {fmt(s.openTrade.stop)}，目標 {fmt(s.openTrade.target)}，{s.openTrade.entryBarTime.slice(5, 16).replace("T", " ")} UTC 進
                </p>
              )}
              {s.gaps.length > 0 && <p className="mt-1 text-[10px] text-amber-400/70">{s.gaps.join("；")}</p>}
            </section>
          );
        })}
      </div>

      {data && data.recent.length > 0 && (
        <details className="mt-3 rounded-xl border border-neutral-800 bg-neutral-900/40 p-3">
          <summary className="cursor-pointer text-xs text-neutral-300">紙上帳本最近 {data.recent.length} 筆</summary>
          <table className="mt-2 w-full text-[11px]">
            <thead className="text-neutral-500"><tr><th className="text-left font-normal">商品</th><th className="text-left font-normal">方向</th><th className="text-right font-normal">進場</th><th className="text-right font-normal">停損</th><th className="text-right font-normal">出場</th><th className="text-right font-normal">狀態</th></tr></thead>
            <tbody>
              {data.recent.map((t) => (
                <tr key={t.id} className="border-t border-neutral-800/60 text-neutral-300">
                  <td>{t.symbol}</td>
                  <td className={t.direction === "long" ? "text-emerald-300" : "text-red-300"}>{t.direction === "long" ? "多" : "空"}</td>
                  <td className="text-right tabular-nums">{fmt(t.entry)}</td>
                  <td className="text-right tabular-nums">{fmt(t.stop)}</td>
                  <td className="text-right tabular-nums">{fmt(t.exitPrice)}</td>
                  <td className={`text-right ${t.status === "win" ? "text-emerald-300" : t.status === "loss" ? "text-red-300" : "text-sky-300"}`}>{t.status === "open" ? "持倉" : t.status === "win" ? "獲利" : t.status === "loss" ? "虧損" : "到期"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </main>
  );
}

function Tile({ label, value, sub, tone = "" }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950/40 px-3 py-2">
      <p className="text-[11px] text-neutral-500">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${tone || "text-neutral-100"}`}>{value}</p>
      {sub ? <p className="text-[10px] text-neutral-500">{sub}</p> : null}
    </div>
  );
}

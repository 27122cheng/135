"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { COMMODITIES } from "@/types/signal";
import { STOP_REASON_LABELS } from "@/types/journal";
import type { GradePerformance, ReviewStats, TagDistribution } from "@/lib/journal/stats";
import type { TagStat } from "@/types/journal";
import { SeverityTrend, StopReasonDonut, TAG_COLORS } from "@/components/review-charts";
import { JournalForm } from "@/components/journal-form";

interface ReviewResponse extends ReviewStats {
  activeInterventions: TagStat[];
  recentTagStats: TagStat[];
  error?: string;
}

export default function ReviewPage() {
  const [symbol, setSymbol] = useState<string>("");
  const [stats, setStats] = useState<ReviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/review${symbol ? `?symbol=${symbol}` : ""}`);
      const data = (await res.json()) as ReviewResponse;
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setStats(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="mx-auto max-w-2xl px-4 py-5">
      <header className="mb-4 flex items-baseline justify-between gap-3">
        <h1 className="text-base font-bold text-neutral-100">停損復盤</h1>
        <nav className="flex shrink-0 gap-3 text-sm text-neutral-500">
          <Link href="/" className="hover:text-neutral-200">
            訊號
          </Link>
          <Link href="/history" className="hover:text-neutral-200">
            歷史
          </Link>
        </nav>
      </header>

      <div className="mb-4 flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => setSymbol("")}
          className={`rounded-full px-3 py-1 text-xs ${symbol === "" ? "bg-neutral-100 text-neutral-900" : "bg-neutral-800 text-neutral-400"}`}
        >
          全部
        </button>
        {COMMODITIES.map((c) => (
          <button
            key={c.symbol}
            type="button"
            onClick={() => setSymbol(c.symbol)}
            className={`rounded-full px-3 py-1 text-xs ${symbol === c.symbol ? "bg-neutral-100 text-neutral-900" : "bg-neutral-800 text-neutral-400"}`}
          >
            {c.symbol}
          </button>
        ))}
      </div>

      {loading && <p className="py-8 text-center text-sm text-neutral-500">載入中…</p>}

      {error && (
        <div className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-300">
          <p>{error}</p>
          {/* The one error with a one-tap fix gets a button instead of a
              paragraph telling the reader to go and paste SQL somewhere. */}
          {error.includes("資料表尚未建立") ? (
            <SetupButton onDone={load} />
          ) : (
            <p className="mt-1 text-xs leading-relaxed text-amber-400/70">
              交易日誌需要資料庫，兩步驟：① 在 Vercel 加環境變數 <code>DATABASE_URL</code>
              （Neon 免費 Postgres）或 Supabase 三把金鑰 → ② 建立資料表，然後 Redeploy。
              <br />
              資料庫連線字串<span className="text-amber-300">不能</span>在本站的金鑰設定頁填 ——
              那個頁面只收資料來源的金鑰，能寫入資料庫的憑證只放伺服器端。
            </p>
          )}
        </div>
      )}

      {stats && !loading && (
        <div className="flex flex-col gap-4">
          {stats.totalEntries === 0 ? (
            <p className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-6 text-center text-sm text-neutral-500">
              還沒有交易紀錄。在下方記一筆平倉的交易就會開始統計。
            </p>
          ) : (
            <>
              {stats.activeInterventions.length > 0 && (
                <section className="rounded-xl border border-red-500/40 bg-red-500/5 p-4">
                  <h2 className="mb-2 text-sm font-medium text-red-300">目前生效中的干涉</h2>
                  <p className="mb-2 text-[11px] text-neutral-500">
                    近 30 筆中出現 ≥3 次且平均 severity ≥3 的 tag，會自動加嚴新訊號的門檻。
                  </p>
                  <ul className="space-y-1">
                    {stats.activeInterventions.map((t) => (
                      <li key={t.tag} className="text-[11px] text-neutral-300">
                        <span className="font-mono text-red-400">{t.tag}</span>{" "}
                        {STOP_REASON_LABELS[t.tag]} — {t.count} 次，平均 severity {t.avgSeverity}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <Section title="停損原因分布">
                <StopReasonDonut data={stats.tagDistribution} />
              </Section>

              <Section title="severity 趨勢">
                <SeverityTrend points={stats.severityTrend} />
              </Section>

              <Section title="各 tag 累積虧損排行">
                <LossRanking data={stats.lossRanking} />
              </Section>

              <Section title="各等級實際表現">
                <GradeTable data={stats.gradePerformance} />
              </Section>
            </>
          )}

          <Section title="記錄一筆平倉交易">
            <JournalForm defaultSymbol={symbol || "XAUUSD"} onSaved={load} />
          </Section>
        </div>
      )}
    </main>
  );
}

/**
 * Creates the tables via /api/setup. Only appears when the database is
 * reachable but empty — the one failure with a fix the app can perform itself.
 */
function SetupButton({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState<"idle" | "running" | "failed">("idle");
  const [detail, setDetail] = useState<string | null>(null);

  async function run() {
    setState("running");
    setDetail(null);
    try {
      const res = await fetch("/api/setup", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ready) {
        throw new Error(data.error ?? data.errors?.[0]?.error ?? `HTTP ${res.status}`);
      }
      onDone();
    } catch (err) {
      setState("failed");
      setDetail(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={run}
        disabled={state === "running"}
        className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-amber-300 disabled:opacity-50"
      >
        {state === "running" ? "建立中…" : "建立資料表"}
      </button>
      <p className="mt-2 text-[11px] leading-relaxed text-amber-400/70">
        會對 <code>DATABASE_URL</code> 指向的資料庫執行 <code>supabase/schema.sql</code>。
        全部是 <code>create table if not exists</code>，重複執行不會破壞既有資料。
      </p>
      {detail && <p className="mt-1 text-[11px] text-red-300">{detail}</p>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
      <h2 className="mb-3 text-sm font-medium text-neutral-200">{title}</h2>
      {children}
    </section>
  );
}

function LossRanking({ data }: { data: TagDistribution[] }) {
  if (data.length === 0) {
    return <p className="py-4 text-center text-xs text-neutral-600">尚無資料</p>;
  }
  // Bars are scaled to the worst tag, so the top bar is always full width.
  const worst = Math.min(...data.map((d) => d.cumulativeLossPct));
  return (
    <ul className="space-y-2">
      {data.map((d) => (
        <li key={d.tag}>
          <div className="mb-1 flex items-baseline justify-between gap-2 text-[11px]">
            <span className="min-w-0 truncate">
              <span className="font-mono text-neutral-300">{d.tag}</span>{" "}
              <span className="text-neutral-500">{d.label}</span>
            </span>
            <span className="shrink-0 tabular-nums text-red-400">
              {d.cumulativeLossPct.toFixed(2)}%
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
            <div
              className="h-full rounded-full"
              style={{
                width: worst < 0 ? `${Math.max(2, (d.cumulativeLossPct / worst) * 100)}%` : "2%",
                backgroundColor: TAG_COLORS[d.tag],
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function GradeTable({ data }: { data: GradePerformance[] }) {
  if (data.length === 0) {
    return <p className="py-4 text-center text-xs text-neutral-600">尚無資料</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="border-b border-neutral-800 text-neutral-500">
            <th className="py-1.5 text-left font-normal">等級</th>
            <th className="py-1.5 text-right font-normal">筆數</th>
            <th className="py-1.5 text-right font-normal">勝/敗/平</th>
            <th className="py-1.5 text-right font-normal">勝率</th>
            <th className="py-1.5 text-right font-normal">期望值</th>
          </tr>
        </thead>
        <tbody>
          {data.map((g) => (
            <tr key={g.grade} className="border-b border-neutral-900">
              <td className="py-1.5 font-mono text-neutral-200">{g.grade}</td>
              <td className="py-1.5 text-right tabular-nums text-neutral-400">{g.trades}</td>
              <td className="py-1.5 text-right tabular-nums text-neutral-500">
                {g.wins}/{g.losses}/{g.breakeven}
              </td>
              <td className="py-1.5 text-right tabular-nums text-neutral-300">
                {g.winRate === null ? "—" : `${g.winRate}%`}
              </td>
              <td
                className={`py-1.5 text-right tabular-nums ${
                  (g.expectancyPct ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"
                }`}
              >
                {g.expectancyPct === null ? "—" : `${g.expectancyPct.toFixed(2)}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[10px] leading-relaxed text-neutral-600">
        勝率不計平手；期望值是所有交易 pnl_pct 的平均（含平手）。樣本少的時候這些數字不代表什麼 ——
        看的是等級越高表現是不是真的越好。
      </p>
    </div>
  );
}

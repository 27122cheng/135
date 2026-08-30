"use client";

import { useCallback, useEffect, useState } from "react";
import { COMMODITIES } from "@/types/signal";
import { loadCustomSymbols } from "@/lib/custom-symbols";
import { STOP_REASON_LABELS } from "@/types/journal";
import type {
  EquityCurve,
  GradePerformance,
  ReviewStats,
  TagDistribution,
  TrackRecord,
} from "@/lib/journal/stats";
import type { TagStat } from "@/types/journal";
import { SeverityTrend, StopReasonDonut, TAG_COLORS } from "@/components/review-charts";
import { JournalForm } from "@/components/journal-form";
import type { RiskAdvice } from "@/lib/journal/advice";
import { SiteNav } from "@/components/site-nav";

interface BlockerRow {
  id: string;
  label: string;
  count: number;
  share: number;
  tunable: boolean;
  symbols: string[];
}

interface ForwardCondition {
  conditionId: string;
  label: string;
  direction: "long" | "short";
  open: number;
  wins: number;
  losses: number;
  expired: number;
  resolved: number;
  hitRate: number | null;
  taken: number;
}

interface LearningEntry {
  symbol: string;
  direction: "long" | "short";
  grade: string;
  result: string;
  pnlPct: number;
  closedAt: string;
  tag: string | null;
  severity: number | null;
  note: string | null;
}

interface ReviewResponse extends ReviewStats {
  trackRecord?: TrackRecord;
  equityCurve?: EquityCurve;
  recentEntries?: LearningEntry[];
  blockers?: { census: BlockerRow[]; scanned: number; windowDays?: number };
  forward?: {
    conditions: ForwardCondition[];
    resolved: number;
    wins: number;
    hitRate: number | null;
    open: number;
  };
  activeInterventions: TagStat[];
  recentTagStats: TagStat[];
  riskAdvice?: RiskAdvice[];
  error?: string;
}

export default function ReviewPage() {
  const [symbol, setSymbol] = useState<string>("");
  const [roster, setRoster] = useState<{ symbol: string; label: string }[]>(
    () => COMMODITIES.map((c) => ({ symbol: c.symbol, label: c.label })),
  );
  useEffect(() => {
    setRoster([
      ...COMMODITIES.map((c) => ({ symbol: c.symbol, label: c.label })),
      ...loadCustomSymbols().map((c) => ({ symbol: c.symbol, label: c.label })),
    ]);
  }, []);
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
      <SiteNav title="交易建議復盤" />

      <div className="mb-4 flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => setSymbol("")}
          className={`rounded-full px-3 py-1 text-xs ${symbol === "" ? "bg-neutral-100 text-neutral-900" : "bg-neutral-800 text-neutral-400"}`}
        >
          全部
        </button>
        {roster.map((c) => (
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
          {/* The headline: how the system's own recommendations actually did.
              This page reviews the signals, not the reader's personal book —
              every 進場 recommendation is auto-settled by the 5-minute monitor
              and lands here without anyone typing anything. */}
          <Section title="交易建議的實際命中率（監控自動結算）">
            {stats.trackRecord ? (
              <TrackRecordTable record={stats.trackRecord} />
            ) : (
              <p className="text-xs text-neutral-500">
                每筆建議進場的訊號由 5 分鐘監控自動追蹤到停損或停利，結算後自動記錄在這裡 —
                不需要手動輸入。目前還沒有結算完成的建議。
              </p>
            )}
          </Section>

          {/* 權益曲線 — the running sum of real trades' pnl, with the deepest
              drawdown named. The one chart a desk reads before any win rate:
              a rising line with shallow dips is the actual goal that 交易量
              and 勝率 are both proxies for. Paper 參考價位 rows are excluded
              server-side. */}
          {stats.equityCurve && stats.equityCurve.points.length >= 2 && (
            <Section title="權益曲線與最大回撤（實際交易，含自動結算與人工記錄）">
              <EquityCurveChart curve={stats.equityCurve} />
            </Section>
          )}

          {/* 止損止盈學習紀錄 — the reviewed entries the aggregates are made
              of. Every resolved trade lands here with its classified reason;
              the S-tags then tighten future signals via the intervention
              engine. This was all happening invisibly — a feedback loop the
              reader cannot see might as well not exist. */}
          {stats.recentEntries && stats.recentEntries.length > 0 && (
            <Section title="止損／止盈學習紀錄（每筆結算的復盤與原因）">
              <LearningLog entries={stats.recentEntries} />
            </Section>
          )}

          {/* 為什麼沒有訊號 — the distribution of rejections.
              With almost nothing entering, the hit-rate table above has no
              denominator and the page reads as empty. This is real data from
              the first scan onward, and it is what says which threshold is
              actually costing the volume. */}
          {stats.blockers && stats.blockers.census.length > 0 && (
            <Section
              title={
                stats.blockers.windowDays
                  ? `最近 ${stats.blockers.windowDays} 天 ${stats.blockers.scanned} 次掃描卡在哪一關`
                  : `目前 ${stats.blockers.scanned} 個商品卡在哪一關`
              }
            >
              <p className="mb-2 text-[11px] leading-relaxed text-neutral-500">
                「訊號太少」不是一個可以直接修的東西，「62% 卡在找不到停利結構」才是。
                這裡是整週掃描的分布，不是單一時刻的快照 —— 佔比最高又標
                <span className="text-amber-400">可調</span>的那一關，就是門檻鬆緊的討論對象；
                沒標的是市場本身就沒有給的條件，調了也沒用。
              </p>
              <table className="w-full">
                <thead>
                  <tr className="text-left text-[11px] text-neutral-500">
                    <th className="py-1 font-normal">關卡</th>
                    <th className="py-1 text-right font-normal">數量</th>
                    <th className="py-1 text-right font-normal">佔比</th>
                    <th className="py-1 pl-2 font-normal">商品</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.blockers.census.map((b) => (
                    <tr key={b.id} className="border-t border-neutral-800">
                      <td className="py-1.5 pr-2 text-[11px] text-neutral-300">
                        {b.label}
                        {b.tunable && (
                          <span className="ml-1 rounded bg-amber-500/15 px-1 py-0.5 text-[9px] text-amber-400">
                            可調
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 text-right font-mono text-[11px] text-neutral-400">
                        {b.count}
                      </td>
                      <td className="py-1.5 text-right font-mono text-[11px] text-neutral-500">
                        {b.share}%
                      </td>
                      <td className="py-1.5 pl-2 text-[11px] text-neutral-500">
                        {b.symbols.join("、")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}

          {/* 前進實驗 — the other track record, and the one that fills up
              whether or not the gates ever let a signal through. */}
          {stats.forward && (stats.forward.resolved > 0 || stats.forward.open > 0) && (
            <Section title="前進實驗的實際結果（每個進場條件各自下單）">
              <p className="mb-2 text-[11px] leading-relaxed text-neutral-500">
                累計結算 {stats.forward.resolved} 筆、進行中 {stats.forward.open} 筆，
                整體勝率{" "}
                <span className="font-mono text-neutral-300">
                  {stats.forward.hitRate === null
                    ? "—"
                    : `${Math.round(stats.forward.hitRate * 100)}%`}
                </span>
                。這些單子在開倉當下就登記好進場、停損、停利，事後不能改。
              </p>
              <table className="w-full">
                <thead>
                  <tr className="text-left text-[11px] text-neutral-500">
                    <th className="py-1 font-normal">條件</th>
                    <th className="py-1 text-right font-normal">勝率</th>
                    <th className="py-1 text-right font-normal">勝／敗</th>
                    <th className="py-1 text-right font-normal">進行中</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.forward.conditions.map((c) => (
                    <tr key={`${c.direction}:${c.conditionId}`} className="border-t border-neutral-800">
                      <td className="py-1.5 pr-2 text-[11px] text-neutral-300">
                        {c.label}
                        <span className="ml-1 text-[11px] text-neutral-500">
                          {c.direction === "long" ? "多" : "空"}
                        </span>
                      </td>
                      <td className="py-1.5 text-right font-mono text-[11px] text-neutral-400">
                        {c.hitRate === null ? "—" : `${Math.round(c.hitRate * 100)}%`}
                        <span className="ml-1 text-[11px] text-neutral-500">n={c.resolved}</span>
                      </td>
                      <td className="py-1.5 text-right font-mono text-[11px] text-neutral-500">
                        {c.wins}／{c.losses}
                      </td>
                      <td className="py-1.5 text-right font-mono text-[11px] text-neutral-500">
                        {c.open}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}

          {stats.riskAdvice && stats.riskAdvice.length > 0 && (
            <Section title="風控與停損建議">
              <RiskAdviceList items={stats.riskAdvice} />
            </Section>
          )}

          {stats.activeInterventions.length > 0 && (
            <section className="rounded-xl border border-red-500/40 bg-red-500/5 p-4">
              <h2 className="mb-2 text-sm font-medium text-red-300">
                已從止損原因學到、正在套用的調整
              </h2>
              <p className="mb-2 text-[11px] text-neutral-500">
                近 30 筆中出現 ≥3 次且平均 severity ≥3 的原因，會自動加嚴之後每一筆交易建議的門檻
                — 只會收緊，不會放寬。
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

          {stats.totalEntries === 0 ? (
            <p className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-6 text-center text-sm text-neutral-500">
              還沒有已結算的交易建議。監控結算第一筆（停損或停利）之後，
              停損原因分布與各等級表現會開始累積。
            </p>
          ) : (
            <>
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

          {/* Manual entry stays available for trades taken outside the system,
              but collapsed — the recommendations record themselves. */}
          <details className="rounded-xl border border-neutral-800 bg-neutral-900/40">
            <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-neutral-400">
              手動補記一筆自己的交易（選填 — 系統的建議會自動記錄，不用填這裡）
            </summary>
            <div className="px-4 pb-4">
              <JournalForm defaultSymbol={symbol || "XAUUSD"} onSaved={load} />
            </div>
          </details>
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

/**
 * 風控與停損建議 — each line pairs what the reader should do with what the
 * engine already enforces automatically, so "the system learned from this"
 * is a checkable claim instead of a vibe. Advice for causes that never
 * happened is not shown; the baseline rules always are.
 */
function RiskAdviceList({ items }: { items: RiskAdvice[] }) {
  return (
    <ul className="flex flex-col gap-2.5">
      {items.map((a, i) => (
        <li key={i} className="rounded-lg border border-neutral-800 bg-neutral-950/50 p-3">
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs font-medium text-neutral-200">{a.title}</p>
            {a.active && a.tag && (
              <span className="shrink-0 rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] font-medium text-red-400">
                干涉生效中
              </span>
            )}
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-neutral-400">{a.detail}</p>
          {a.basedOn && (
            <p className="mt-1 text-[11px] text-neutral-500">依據：{a.basedOn}</p>
          )}
          {a.automated && (
            <p className="mt-1 text-[11px] leading-relaxed text-emerald-500/70">
              系統已自動化：{a.automated}
              {a.tag && !a.active && "（此原因尚未達到觸發門檻，達標後自動生效）"}
            </p>
          )}
        </li>
      ))}
    </ul>
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
    return <p className="py-4 text-center text-xs text-neutral-500">尚無資料</p>;
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

/**
 * 正式訊號 vs 參考價位, side by side — the comparison the paper tracking
 * exists to make.
 *
 * If the paper bucket beats the real one over a real sample, the entry gate is
 * throwing away winners and its thresholds deserve another look; if it loses,
 * the gate is earning its keep. Either answer is useful, which is why both
 * numbers sit on one row. Paper fills are assumed perfect — stated here, so
 * its win rate is read as a ceiling rather than a promise.
 */
/**
 * 權益曲線 — an inline SVG, no chart library. Additive pnl% per trade (sizes
 * are unknown by design: account size never leaves the browser), zero line
 * marked, the deepest drawdown's trough dotted in red. Scales itself to the
 * data; with two points it is a line, with fifty it is a curve.
 */
function EquityCurveChart({ curve }: { curve: EquityCurve }) {
  const W = 560;
  const H = 120;
  const PAD = 6;
  const values = [0, ...curve.points.map((p) => p.equityPct)];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => PAD + (i / (values.length - 1 || 1)) * (W - PAD * 2);
  const y = (v: number) => PAD + ((max - v) / span) * (H - PAD * 2);
  const path = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const troughIdx =
    curve.maxDrawdownAt === null
      ? -1
      : curve.points.findIndex((p) => p.closedAt === curve.maxDrawdownAt);
  const last = curve.points[curve.points.length - 1];
  const up = curve.totalPct >= 0;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        <span className={up ? "text-emerald-400" : "text-red-400"}>
          累計 {curve.totalPct > 0 ? "+" : ""}
          {curve.totalPct}%
        </span>
        <span className="text-red-400/80">最大回撤 {curve.maxDrawdownPct}%</span>
        <span className="text-neutral-500">最長連敗 {curve.longestLossStreak} 筆</span>
        {curve.currentStreak.kind !== "none" && (
          <span className="text-neutral-500">
            目前連{curve.currentStreak.kind === "win" ? "勝" : "敗"} {curve.currentStreak.length} 筆
          </span>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="權益曲線">
        <line
          x1={PAD}
          x2={W - PAD}
          y1={y(0)}
          y2={y(0)}
          stroke="#525252"
          strokeWidth="0.5"
          strokeDasharray="3 3"
        />
        <path d={path} fill="none" stroke={up ? "#34d399" : "#f87171"} strokeWidth="1.5" />
        {troughIdx >= 0 && (
          <circle
            cx={x(troughIdx + 1)}
            cy={y(curve.points[troughIdx].equityPct)}
            r="3"
            fill="none"
            stroke="#f87171"
            strokeWidth="1.2"
          />
        )}
      </svg>
      <p className="text-[11px] leading-relaxed text-neutral-500">
        每筆以進場價的損益百分比累加（不複利、不假設倉位大小 —— 帳戶資金只存在你的瀏覽器）。
        紅圈是最深回撤的谷底
        {curve.maxDrawdownAt ? `（${curve.maxDrawdownAt.slice(0, 10)}）` : ""}。
        最大回撤和最長連敗是倉位大小必須撐得過的兩個數字 —— 風控頁的單筆風險 % 乘上最長連敗，
        就是這套系統歷史上會讓你經歷的最痛一段。
        {last ? ` 最近一筆：${last.symbol} ${last.pnlPct > 0 ? "+" : ""}${last.pnlPct}%。` : ""}
      </p>
    </div>
  );
}

const RESULT_LABEL: Record<string, { text: string; tone: string }> = {
  win: { text: "獲利", tone: "text-emerald-400" },
  loss: { text: "虧損", tone: "text-red-400" },
  breakeven: { text: "打平", tone: "text-neutral-400" },
};

/**
 * 學習紀錄 — one card per resolved trade: what happened, how it was
 * classified, and the reason written at classification time. The S-tag on a
 * loss is what the intervention engine reads to tighten future signals, so
 * each tagged entry names that consequence instead of leaving 「有在學」as
 * an unverifiable claim.
 */
function LearningLog({ entries }: { entries: LearningEntry[] }) {
  return (
    <div className="flex flex-col gap-2">
      {entries.map((e, i) => {
        const r = RESULT_LABEL[e.result] ?? { text: e.result, tone: "text-neutral-400" };
        return (
          <div key={`${e.symbol}-${e.closedAt}-${i}`} className="rounded-lg border border-neutral-800 bg-neutral-950/50 px-3 py-2">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
              <span className="text-neutral-500">{e.closedAt.slice(0, 10)}</span>
              <span className="font-medium text-neutral-200">{e.symbol}</span>
              <span className={e.direction === "long" ? "text-emerald-400/80" : "text-red-400/80"}>
                {e.direction === "long" ? "多" : "空"}
              </span>
              <span className="rounded bg-neutral-800 px-1 py-0.5 text-[11px] text-neutral-400">{e.grade}</span>
              <span className={`font-medium ${r.tone}`}>{r.text}</span>
              <span className={`font-mono ${e.pnlPct > 0 ? "text-emerald-400" : e.pnlPct < 0 ? "text-red-400" : "text-neutral-400"}`}>
                {e.pnlPct > 0 ? "+" : ""}
                {e.pnlPct}%
              </span>
              {e.tag && (
                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-400">
                  {e.tag} {STOP_REASON_LABELS[e.tag as keyof typeof STOP_REASON_LABELS] ?? ""}
                </span>
              )}
              {e.severity !== null && (
                <span className="text-[11px] text-neutral-500">嚴重度 {e.severity}</span>
              )}
            </div>
            {e.note && (
              <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">{e.note}</p>
            )}
          </div>
        );
      })}
      <p className="text-[11px] leading-relaxed text-neutral-500">
        這就是「學習」實際發生的地方：每筆自動結算的交易寫入一則復盤（[自動追蹤] 開頭），
        停損由規則或 AI 分類成 S1–S8 並寫下原因；被分類的原因會透過干涉引擎
        <span className="text-neutral-400">收緊之後的訊號</span>（上方「目前生效的干涉」區）。
        打平（保本／移停洗出）不列入停損分類 —— 那是管理規則運作的結果，不是要修的錯。
        獲利單只記錄不復盤：S1–S8 是虧損的分類法。
      </p>
    </div>
  );
}

function TrackRecordTable({ record }: { record: TrackRecord }) {
  const rows = [record.real, record.paper, record.manual].filter((b) => b.trades > 0);
  if (rows.length === 0) {
    return (
      <p className="text-xs text-neutral-500">
        監控結算的交易會自動記到這裡（正式訊號與參考價位分開統計），目前還沒有結算的紀錄。
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[11px] text-neutral-500">
            <th className="py-1 font-normal">來源</th>
            <th className="py-1 text-right font-normal">筆數</th>
            <th className="py-1 text-right font-normal">勝/敗</th>
            <th className="py-1 text-right font-normal">勝率</th>
            <th className="py-1 text-right font-normal">盈虧比</th>
            <th className="py-1 text-right font-normal">期望值%</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.label} className="border-t border-neutral-800">
              <td className="py-1.5 text-neutral-300">{b.label}</td>
              <td className="py-1.5 text-right font-mono text-neutral-400">{b.trades}</td>
              <td className="py-1.5 text-right font-mono text-neutral-400">
                {b.wins}/{b.losses}
              </td>
              {/* 勝率 next to the rate it must beat: a win rate has no meaning
                  without the payoff ratio's breakeven bar beside it. */}
              <td className="py-1.5 text-right font-mono text-neutral-200">
                {b.winRate === null ? "—" : `${b.winRate}%`}
                {b.breakevenWinRate !== null && (
                  <span className="text-[11px] text-neutral-500"> /需{b.breakevenWinRate}%</span>
                )}
              </td>
              <td className="py-1.5 text-right font-mono text-neutral-400">
                {b.payoffRatio === null ? "—" : b.payoffRatio}
              </td>
              <td
                className={`py-1.5 text-right font-mono ${
                  (b.expectancyPct ?? 0) > 0 ? "text-emerald-400" : (b.expectancyPct ?? 0) < 0 ? "text-red-400" : "text-neutral-400"
                }`}
              >
                {b.expectancyPct === null ? "—" : b.expectancyPct}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] leading-relaxed text-neutral-500">
        <span className="text-neutral-400">期望值</span>＝每筆結算交易的平均損益，才是「有沒有賺」的答案；
        勝率旁的「需 x%」是這個盈虧比損益兩平所需的勝率——實際勝率高於它才是正期望，
        低於它就算勝率 70% 也在虧。紙上追蹤假設完美成交、無滑價點差，讀作上限；
        若紙上長期贏過正式訊號，代表進場門檻把贏家擋掉了，值得回頭調整；若輸，代表門檻有在賺它的位置。
      </p>
    </div>
  );
}

function GradeTable({ data }: { data: GradePerformance[] }) {
  if (data.length === 0) {
    return <p className="py-4 text-center text-xs text-neutral-500">尚無資料</p>;
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
      <p className="mt-2 text-[11px] leading-relaxed text-neutral-500">
        勝率不計平手；期望值是所有交易 pnl_pct 的平均（含平手）。樣本少的時候這些數字不代表什麼 ——
        看的是等級越高表現是不是真的越好。
      </p>
    </div>
  );
}

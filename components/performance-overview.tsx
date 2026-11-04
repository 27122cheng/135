"use client";

import { TARGET_WIN_RATE, type PerformanceReport, type PeriodStats } from "@/lib/journal/performance";

/**
 * 績效總覽 — the verdict first, then the four numbers a desk reads, then
 * whether the book is learning. Everything here is the real stream only.
 *
 * Layout rule: a trader should know in two seconds (1) is the system
 * improving, (2) is the win rate real or a streak, (3) how deep the hole has
 * been. Detail tables live below and stay collapsed.
 */

const LEVEL_TONE: Record<PerformanceReport["verdict"]["level"], { border: string; text: string; icon: string }> = {
  improving: { border: "border-emerald-500/40 bg-emerald-500/[0.07]", text: "text-emerald-300", icon: "▲" },
  worsening: { border: "border-red-500/40 bg-red-500/[0.07]", text: "text-red-300", icon: "▼" },
  flat: { border: "border-neutral-700 bg-neutral-900/40", text: "text-neutral-200", icon: "■" },
  insufficient: { border: "border-amber-500/40 bg-amber-500/[0.07]", text: "text-amber-300", icon: "…" },
};

const fmt = (n: number | null | undefined, unit = "", digits = 1) =>
  n === null || n === undefined ? "—" : `${n > 0 && unit === "%" ? "+" : ""}${Number(n.toFixed(digits))}${unit}`;

export function PerformanceOverview({ report }: { report: PerformanceReport }) {
  const tone = LEVEL_TONE[report.verdict.level];
  const wr = report.winRate;
  return (
    <div className="flex flex-col gap-3">
      {/* 1. The verdict. */}
      <div className={`rounded-xl border p-3 ${tone.border}`}>
        <p className={`text-sm font-medium ${tone.text}`}>
          {tone.icon} {report.verdict.headline}
        </p>
        <p className="mt-1 text-[12px] leading-relaxed text-neutral-400">{report.verdict.detail}</p>
      </div>

      {/* 2. Four tiles. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile
          label="勝率"
          value={wr.rate === null ? "—" : `${wr.rate}%`}
          sub={wr.rate === null ? "尚無結算" : `95% 區間 ${wr.low}–${wr.high}%`}
          tone={wr.rate === null ? "neutral" : report.breakevenWinRate !== null && wr.rate >= report.breakevenWinRate ? "good" : "bad"}
        />
        <Tile
          label="期望值／筆"
          value={fmt(report.expectancyPct, "%", 2)}
          sub={report.breakevenWinRate !== null ? `損益兩平需勝率 ${report.breakevenWinRate}%` : "需要勝負各至少一筆"}
          tone={report.expectancyPct === null ? "neutral" : report.expectancyPct > 0 ? "good" : "bad"}
        />
        <Tile
          label="最大回撤"
          value={fmt(report.maxDrawdownPct, "%", 2)}
          sub={report.currentDrawdownPct < 0 ? `目前距高點 ${report.currentDrawdownPct}%` : "目前在權益高點"}
          tone={report.maxDrawdownPct === 0 ? "neutral" : report.currentDrawdownPct < 0 ? "bad" : "good"}
        />
        <Tile
          label="累計 / 獲利因子"
          value={fmt(report.totalPct, "%", 2)}
          sub={
            report.profitFactor !== null
              ? `獲利因子 ${report.profitFactor}${report.recoveryFactor !== null ? `，賺回 ${report.recoveryFactor} 個回撤` : ""}`
              : "獲利因子需勝負各至少一筆"
          }
          tone={report.totalPct > 0 ? "good" : report.totalPct < 0 ? "bad" : "neutral"}
        />
      </div>

      {/* 3. The win-rate band: where the rate sits, how wide the doubt is,
             the breakeven line it must clear and the 80% goal. */}
      {wr.rate !== null && wr.low !== null && wr.high !== null && (
        <WinRateBand rate={wr.rate} low={wr.low} high={wr.high} breakeven={report.breakevenWinRate} />
      )}
      <p className="text-[11px] leading-relaxed text-neutral-500">
        {report.sampleNote} {report.targetNote}
      </p>

      {/* 4. Learning growth: periods side by side, then the rolling line. */}
      {report.periods.length >= 2 && <PeriodTable periods={report.periods} learning={report.learning} />}
      {report.rolling.length >= 2 && <RollingChart report={report} />}

      {/* 5. Control group. */}
      {report.intervention && (
        <div className="rounded-lg border border-neutral-800 bg-neutral-950/40 p-2.5 text-[12px]">
          <p className="mb-1 text-neutral-300">已干涉 vs 未干涉（停損復盤收緊過的交易，對照其餘交易）</p>
          <div className="grid grid-cols-2 gap-2 text-[11px] text-neutral-400">
            <span>
              已干涉 {report.intervention.with.trades} 筆：勝率 {fmt(report.intervention.with.winRate.rate, "%")}，期望值 {fmt(report.intervention.with.expectancyPct, "%", 2)}
            </span>
            <span>
              未干涉 {report.intervention.without.trades} 筆：勝率 {fmt(report.intervention.without.winRate.rate, "%")}，期望值 {fmt(report.intervention.without.expectancyPct, "%", 2)}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-neutral-500">{report.intervention.note}</p>
        </div>
      )}
      <p className="text-[11px] leading-relaxed text-neutral-600">
        只算正式訊號（監控自動結算的真實交易）；參考價位的紙上追蹤假設完美成交，不在這裡。
        打平的交易不計入勝率，但計入累計與回撤。回撤以每筆損益百分比累加，不複利、不假設倉位。
        連敗最長 {report.longestLossStreak} 筆、最久 {report.longestUnderwater} 筆未創新高 —— 倉位大小要撐得過這兩個數字。
      </p>
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: "good" | "bad" | "neutral" }) {
  const color = tone === "good" ? "text-emerald-300" : tone === "bad" ? "text-red-300" : "text-neutral-200";
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950/40 px-3 py-2">
      <p className="text-[11px] text-neutral-500">{label}</p>
      <p className={`text-xl font-semibold tabular-nums ${color}`}>{value}</p>
      <p className="text-[10px] leading-snug text-neutral-500">{sub}</p>
    </div>
  );
}

function WinRateBand({ rate, low, high, breakeven }: { rate: number; low: number; high: number; breakeven: number | null }) {
  // 360 wide so the labels stay legible once the SVG is scaled to a phone.
  const W = 360;
  const H = 54;
  const x = (pct: number) => 14 + (pct / 100) * (W - 28);
  const mid = 28;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-md" role="img" aria-label="勝率區間">
      <line x1={x(0)} x2={x(100)} y1={mid} y2={mid} stroke="#404040" strokeWidth="5" strokeLinecap="round" />
      <line x1={x(low)} x2={x(high)} y1={mid} y2={mid} stroke="#60a5fa" strokeWidth="8" strokeLinecap="round" opacity="0.55" />
      <circle cx={x(rate)} cy={mid} r="5.5" fill="#e5e5e5" />
      {breakeven !== null && (
        <>
          <line x1={x(breakeven)} x2={x(breakeven)} y1={mid - 11} y2={mid + 11} stroke="#f87171" strokeWidth="1.4" strokeDasharray="2 2" />
          {/* Top row with the target; the bottom row belongs to the rate alone. */}
          <text x={x(breakeven)} y={11} fontSize="10" fill="#f87171" textAnchor={breakeven < 15 ? "start" : "middle"}>
            兩平 {breakeven}%
          </text>
        </>
      )}
      <line x1={x(TARGET_WIN_RATE)} x2={x(TARGET_WIN_RATE)} y1={mid - 11} y2={mid + 11} stroke="#34d399" strokeWidth="1.4" />
      <text x={x(TARGET_WIN_RATE)} y={11} fontSize="10" fill="#34d399" textAnchor="middle">
        目標 {TARGET_WIN_RATE}%
      </text>
      <text x={x(0)} y={11} fontSize="9" fill="#737373">0%</text>
      <text x={x(100)} y={11} fontSize="9" fill="#737373" textAnchor="end">100%</text>
      <text x={x(rate)} y={H - 4} fontSize="10" fill="#e5e5e5" textAnchor={rate < 20 ? "start" : rate > 80 ? "end" : "middle"}>
        勝率 {rate}%（{low}–{high}）
      </text>
    </svg>
  );
}

function PeriodTable({ periods, learning }: { periods: PeriodStats[]; learning: PerformanceReport["learning"] }) {
  const rows: Array<{ label: string; get: (p: PeriodStats) => string; metric: string }> = [
    { label: "結算筆數", get: (p) => `${p.trades}`, metric: "" },
    { label: "勝率", get: (p) => (p.winRate.rate === null ? "—" : `${p.winRate.rate}%`), metric: "勝率" },
    { label: "期望值／筆", get: (p) => fmt(p.expectancyPct, "%", 2), metric: "期望值／筆" },
    { label: "期內最大回撤", get: (p) => fmt(p.maxDrawdownPct, "%", 2), metric: "期內最大回撤" },
    { label: "可預防虧損占比", get: (p) => (p.preventableSharePct === null ? "—" : `${p.preventableSharePct}%`), metric: "可預防虧損占比" },
    { label: "平均 severity", get: (p) => fmt(p.avgSeverity, "", 2), metric: "平均 severity" },
    { label: "已干涉占比", get: (p) => (p.intervenedSharePct === null ? "—" : `${p.intervenedSharePct}%`), metric: "" },
  ];
  const deltaOf = (metric: string) => learning.find((d) => d.metric === metric);
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-800">
      <table className="w-full text-[11px]">
        <thead className="bg-neutral-900/60 text-neutral-500">
          <tr>
            <th className="px-2 py-1.5 text-left font-normal">學習成長</th>
            {periods.map((p) => (
              <th key={p.label} className="whitespace-nowrap px-2 py-1.5 text-right font-normal">
                {p.label}
                <span className="block whitespace-nowrap text-[9px] text-neutral-600">
                  {p.from?.slice(5, 10)}–{p.to?.slice(5, 10)}
                </span>
              </th>
            ))}
            <th className="whitespace-nowrap px-2 py-1.5 text-right font-normal">近期 − 前期</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const d = r.metric ? deltaOf(r.metric) : undefined;
            const toneClass = d?.better === true ? "text-emerald-300" : d?.better === false ? "text-red-300" : "text-neutral-500";
            return (
              <tr key={r.label} className="border-t border-neutral-800/70 text-neutral-300">
                <td className="whitespace-nowrap px-2 py-1 text-neutral-400">{r.label}</td>
                {periods.map((p) => (
                  <td key={p.label} className="px-2 py-1 text-right tabular-nums">
                    {r.get(p)}
                  </td>
                ))}
                <td className={`px-2 py-1 text-right tabular-nums ${toneClass}`}>
                  {d && d.delta !== null
                    ? `${d.better === true ? "▲" : d.better === false ? "▼" : ""} ${d.delta > 0 ? "+" : ""}${d.delta}${d.unit}`
                    : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RollingChart({ report }: { report: PerformanceReport }) {
  const W = 360;
  const H = 80;
  const PAD = 8;
  const pts = report.rolling;
  const x = (i: number) => PAD + (i / (pts.length - 1 || 1)) * (W - PAD * 2);
  const y = (pct: number) => PAD + ((100 - pct) / 100) * (H - PAD * 2);
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.winRate).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <div>
      <p className="mb-1 text-[11px] text-neutral-500">
        滾動勝率（每 {report.rollingWindow} 筆一個點，最新 {last.winRate}%，同窗期望值 {fmt(last.expectancyPct, "%", 2)}）
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-lg" role="img" aria-label="滾動勝率">
        <line x1={PAD} x2={W - PAD} y1={y(TARGET_WIN_RATE)} y2={y(TARGET_WIN_RATE)} stroke="#34d399" strokeWidth="0.6" strokeDasharray="3 3" />
        <text x={W - PAD} y={y(TARGET_WIN_RATE) - 2} fontSize="9" fill="#34d399" textAnchor="end">目標 {TARGET_WIN_RATE}%</text>
        {report.breakevenWinRate !== null && (
          <>
            <line x1={PAD} x2={W - PAD} y1={y(report.breakevenWinRate)} y2={y(report.breakevenWinRate)} stroke="#f87171" strokeWidth="0.6" strokeDasharray="3 3" />
            <text x={W - PAD} y={y(report.breakevenWinRate) + 10} fontSize="9" fill="#f87171" textAnchor="end">兩平 {report.breakevenWinRate}%</text>
          </>
        )}
        <path d={path} fill="none" stroke="#60a5fa" strokeWidth="1.5" />
        <circle cx={x(pts.length - 1)} cy={y(last.winRate)} r="3" fill="#60a5fa" />
      </svg>
    </div>
  );
}

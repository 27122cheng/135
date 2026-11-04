"use client";

import type { TradeSignal } from "@/types/signal";

/**
 * 量化與訂單流 — two short columns on the card.
 *
 * Left: what the instrument is doing in numbers (vol regime, extension,
 * autocorrelation, momentum, expected move, the plan's base rate). Right:
 * who was pushing on the bars (CVD, divergence, absorption, climax,
 * pullback volume). Both are computed server-side with the signal, so the
 * card shows the figures the vote used, not a re-derivation.
 */
export function QuantFlowCard({ signal }: { signal: TradeSignal }) {
  const q = signal.quant ?? null;
  const of = signal.order_flow ?? null;
  if (!q && !of) return null;
  const cvdTone = of?.cvdTrend === "up" ? "text-emerald-300" : of?.cvdTrend === "down" ? "text-red-300" : "text-neutral-300";
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-3">
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p className="text-xs font-medium text-neutral-200">量化與訂單流</p>
        <p className="text-[10px] text-neutral-500">
          {q ? `${q.volLabel}｜${q.autocorrLabel}` : ""}
          {q && of ? "｜" : ""}
          {of ? (
            <>
              CVD <span className={cvdTone}>{of.cvdTrend === "up" ? "淨買" : of.cvdTrend === "down" ? "淨賣" : "持平"}</span>
              {of.source === "range-proxy" ? "（代理）" : ""}
            </>
          ) : ""}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {q && (
          <ul className="flex flex-col gap-0.5 text-[11px] leading-relaxed text-neutral-400">
            <li className="text-[10px] text-neutral-500">量化（D1，{q.bars} 根）</li>
            {q.lines.map((l) => (
              <li key={l} className={l.includes("過度延伸") || l.includes("目標偏遠") ? "text-amber-300" : undefined}>{l}</li>
            ))}
          </ul>
        )}
        {of && (
          <ul className="flex flex-col gap-0.5 text-[11px] leading-relaxed text-neutral-400">
            <li className="text-[10px] text-neutral-500">
              訂單流（{of.timeframe}，{of.bars} 根，{of.source === "volume" ? "成交量" : "振幅代理"}）
            </li>
            {of.lines.map((l) => (
              <li key={l} className={l.includes("背離") || l.includes("高潮") || l.includes("放量") ? "text-amber-300" : l.includes("吸收") || l.includes("健康") ? "text-emerald-300" : undefined}>{l}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

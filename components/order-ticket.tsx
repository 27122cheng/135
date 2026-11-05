"use client";

import { buildOrderTicket } from "@/lib/analysis/order-ticket";
import type { TradeSignal } from "@/types/signal";

/**
 * 執行單 — the plan as orders, for a trader following with a real account.
 * Size lives in the sizing block beneath (the account number never leaves
 * the browser); this block is the what-to-type, in order.
 */
export function OrderTicket({ signal }: { signal: TradeSignal }) {
  const ticket = buildOrderTicket(signal);
  if (!ticket) return null;
  return (
    <div className="rounded-xl border border-neutral-700 bg-neutral-950/60 p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <p className="text-xs font-medium text-neutral-200">執行單 — {ticket.headline}</p>
        <p className="text-[10px] text-neutral-500">部位大小見下方</p>
      </div>
      <dl className="flex flex-col gap-1.5">
        {ticket.lines.map((l) => (
          <div key={l.label} className="grid grid-cols-[4.5rem_1fr] gap-x-2 text-[12px]">
            <dt className="text-neutral-500">{l.label}</dt>
            <dd>
              <span className="font-mono text-neutral-100">{l.value}</span>
              {l.note && <span className="block text-[10px] leading-snug text-neutral-500">{l.note}</span>}
            </dd>
          </div>
        ))}
      </dl>
      <ol className="mt-2.5 list-decimal border-t border-neutral-800 pl-5 pt-2 text-[11px] leading-relaxed text-neutral-400">
        {ticket.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
    </div>
  );
}

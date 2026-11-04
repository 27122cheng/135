"use client";

import { useState } from "react";
import { entryChecklist, type StepStatus } from "@/lib/analysis/checklist";
import type { TradeSignal } from "@/types/signal";

/**
 * 進場前七關 — the checklist strip on a signal card.
 *
 * Seven dots read in one glance; tap to open the evidence behind each. The
 * dots are computed from the signal (lib/analysis/checklist.ts), never typed
 * in, so a green dot is a claim the reader can check against the card.
 */

const DOT: Record<StepStatus, string> = {
  pass: "bg-emerald-400",
  warn: "bg-amber-400",
  fail: "bg-red-400",
};
const TEXT: Record<StepStatus, string> = {
  pass: "text-emerald-300",
  warn: "text-amber-300",
  fail: "text-red-300",
};
const MARK: Record<StepStatus, string> = { pass: "✓", warn: "!", fail: "✕" };

export function EntryChecklistStrip({ signal }: { signal: TradeSignal }) {
  const list = entryChecklist(signal);
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 text-left"
        aria-expanded={open}
      >
        <span className="text-xs font-medium text-neutral-200">進場前七關 — {list.summary}</span>
        <span className="text-[10px] text-neutral-500">{open ? "收起" : "看依據"}</span>
      </button>
      <ol className="mt-2 grid grid-cols-7 gap-1">
        {list.steps.map((s) => (
          <li key={s.n} className="flex flex-col items-center gap-1">
            <span className={`h-2.5 w-2.5 rounded-full ${DOT[s.status]}`} aria-label={`${s.label} ${s.status}`} />
            <span className="text-[10px] text-neutral-400">{s.label}</span>
          </li>
        ))}
      </ol>
      {open && (
        <ol className="mt-2.5 flex flex-col gap-1.5 border-t border-neutral-800 pt-2.5">
          {list.steps.map((s) => (
            <li key={s.n} className="flex gap-2 text-[11px] leading-relaxed">
              <span className={`w-4 shrink-0 font-mono ${TEXT[s.status]}`}>{MARK[s.status]}</span>
              <span className="w-8 shrink-0 text-neutral-300">{s.label}</span>
              <span className="text-neutral-400">
                <span className="text-neutral-500">{s.question}：</span>
                {s.note}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

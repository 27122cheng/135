"use client";

import { COMMODITIES, type SupportedSymbol } from "@/types/signal";
import { cn } from "@/lib/utils";

export function CommodityList({
  selected,
  onSelect,
}: {
  selected: SupportedSymbol;
  onSelect: (symbol: SupportedSymbol) => void;
}) {
  return (
    <nav className="flex flex-col gap-1">
      {COMMODITIES.map((c) => (
        <button
          key={c.symbol}
          type="button"
          disabled={!c.implemented}
          onClick={() => c.implemented && onSelect(c.symbol)}
          className={cn(
            "flex items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors",
            c.implemented
              ? "cursor-pointer hover:bg-neutral-800"
              : "cursor-not-allowed opacity-40",
            selected === c.symbol && c.implemented
              ? "bg-neutral-800 text-neutral-50"
              : "text-neutral-300",
          )}
        >
          <span>{c.label}</span>
          {!c.implemented && (
            <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-500">
              敬請期待
            </span>
          )}
        </button>
      ))}
    </nav>
  );
}

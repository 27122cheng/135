"use client";

import type { CommodityMeta } from "@/types/signal";
import { cn } from "@/lib/utils";

/**
 * Horizontally scrollable chip row — works the same on a phone and a desktop,
 * and replaces the fixed-width sidebar that got clipped on narrow screens.
 */
export function CommodityList({
  symbols,
  selected,
  onSelect,
}: {
  symbols: CommodityMeta[];
  selected: string;
  onSelect: (symbol: string) => void;
}) {
  return (
    <nav className="-mx-4 overflow-x-auto px-4 pb-1">
      <div className="flex gap-2">
        {symbols.map((c) => (
          <button
            key={c.symbol}
            type="button"
            onClick={() => onSelect(c.symbol)}
            className={cn(
              "shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm transition-colors",
              selected === c.symbol
                ? "border-neutral-100 bg-neutral-100 font-medium text-neutral-900"
                : "border-neutral-700 text-neutral-300 hover:border-neutral-500 hover:text-neutral-100",
            )}
          >
            {c.label}
          </button>
        ))}
      </div>
    </nav>
  );
}

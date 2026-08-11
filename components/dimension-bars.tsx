import type { BiasItem } from "@/types/signal";
import { BIAS_DIMENSIONS, computeDimensionScores } from "@/lib/dimension-scores";
import { cn } from "@/lib/utils";

/**
 * 六面向分數 — and, opened, the evidence behind each number.
 *
 * The bars used to be the terminus: 技術面 +5 with nothing to expand, so the
 * one question every score invites — *five from what?* — sent the reader
 * scrolling to 全部因子 and re-sorting fifteen mixed items in their head by
 * dimension. Each row now opens to exactly its own factors: the claim, the
 * direction and weight it voted with, the measured evidence, and which
 * API/candle it came from. Same data the card already carried; the change is
 * that the number and its reasons are finally in the same place.
 *
 * Weight-0 items are listed too, dimmed. "考慮過但不計分" is information — a
 * dimension showing 0 because its items cancelled is a different fact from one
 * that produced nothing, and hiding the zero-weight rows collapses the two.
 */
export function DimensionBars({
  direction,
  biasItems,
}: {
  direction: "long" | "short";
  biasItems: BiasItem[];
}) {
  const scores = computeDimensionScores(direction, biasItems);
  const maxAbs = Math.max(1, ...BIAS_DIMENSIONS.map((d) => Math.abs(scores[d])));

  return (
    <div className="flex flex-col gap-1">
      {BIAS_DIMENSIONS.map((dim) => {
        const score = scores[dim];
        const widthPct = (Math.abs(score) / maxAbs) * 50;
        const items = biasItems.filter((b) => b.dimension === dim);
        return (
          <details key={dim} className="group rounded-lg">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-1 py-1 text-xs hover:bg-neutral-800/40">
              <span className="w-14 shrink-0 text-neutral-400">{dim}</span>
              <div className="relative h-3 flex-1 rounded bg-neutral-800">
                <div className="absolute left-1/2 top-0 h-full w-px bg-neutral-700" />
                {score !== 0 && (
                  <div
                    className={cn(
                      "absolute top-0 h-full rounded",
                      score > 0 ? "bg-emerald-500" : "bg-red-500",
                    )}
                    style={
                      score > 0
                        ? { left: "50%", width: `${widthPct}%` }
                        : { right: "50%", width: `${widthPct}%` }
                    }
                  />
                )}
              </div>
              <span
                className={cn(
                  "w-8 shrink-0 text-right tabular-nums",
                  score > 0 ? "text-emerald-400" : score < 0 ? "text-red-400" : "text-neutral-500",
                )}
              >
                {score > 0 ? `+${score}` : score}
              </span>
              <span className="w-3 shrink-0 text-[10px] text-neutral-600 group-open:rotate-90">
                ▸
              </span>
            </summary>

            <div className="mb-1 ml-2 border-l border-neutral-800 pl-3">
              {items.length === 0 ? (
                <p className="py-1 text-[11px] text-neutral-600">
                  本次沒有產生任何因子（來源失敗或此商品未設定此面向 — 見資料缺口）。
                </p>
              ) : (
                <ul className="flex flex-col gap-1.5 py-1">
                  {items.map((b, i) => (
                    <li key={i} className={cn("text-[11px] leading-relaxed", b.weight === 0 && "opacity-60")}>
                      <p className="text-neutral-300">
                        <span
                          className={cn(
                            "mr-1.5 rounded px-1 py-px text-[10px]",
                            b.direction === "long"
                              ? "bg-emerald-500/15 text-emerald-400"
                              : b.direction === "short"
                                ? "bg-red-500/15 text-red-400"
                                : "bg-neutral-700 text-neutral-300",
                          )}
                        >
                          {b.direction === "long" ? "多" : b.direction === "short" ? "空" : "中"}
                          {b.weight > 0 ? ` ×${b.weight}` : " ·僅參考"}
                        </span>
                        {b.factor}
                      </p>
                      <p className="mt-0.5 text-[10px] text-neutral-500">數據：{b.evidence}</p>
                      <p className="text-[10px] text-neutral-600">來源:{b.source}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </details>
        );
      })}
      <p className="mt-1 px-1 text-[10px] text-neutral-600">
        點任一面向可展開該面向的所有因子：主張、方向與權重、實際數據、資料來源。
      </p>
    </div>
  );
}

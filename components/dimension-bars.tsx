import type { BiasItem } from "@/types/signal";
import { BIAS_DIMENSIONS, computeDimensionScores } from "@/lib/dimension-scores";
import { cn } from "@/lib/utils";

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
    <div className="flex flex-col gap-2">
      {BIAS_DIMENSIONS.map((dim) => {
        const score = scores[dim];
        const widthPct = (Math.abs(score) / maxAbs) * 50;
        return (
          <div key={dim} className="flex items-center gap-2 text-xs">
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
          </div>
        );
      })}
    </div>
  );
}

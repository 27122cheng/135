import { cn } from "@/lib/utils";

/**
 * 賠率結構 — what a win and a loss on this geometry have actually looked like.
 *
 * The card could already say "+0.35R expectancy, 52% hit rate" and the
 * operator still had to ask 「篩選出來的交易容易小獲利或是止損」, because those
 * two numbers genuinely cannot answer it: +0.35R is +0.35R whether it comes
 * from 60% × 1.0R or from 30% × 2.6R, and they are completely different
 * trades to sit in. This draws the third number the pair was hiding.
 *
 * Drawn rather than tabulated, because the whole point is the *shape*: two
 * bars from a shared zero, the win to the right and the loss to the left,
 * on one scale. A payoff of 1.8 looks like 1.8 at a glance; a plan whose
 * winners are smaller than its losers is visibly lopsided the wrong way and
 * no one has to do the division to see it.
 */
export function PayoffShape({
  avgWinR,
  avgLossR,
  payoffRatio,
  scratches,
  className,
}: {
  avgWinR?: number | null;
  avgLossR?: number | null;
  payoffRatio?: number | null;
  scratches?: number | null;
  className?: string;
}) {
  // Rows written before the payoff measurement carry neither number; say
  // nothing rather than draw a bar out of a missing value.
  if (typeof avgWinR !== "number" || typeof avgLossR !== "number") return null;
  const win = Math.abs(avgWinR);
  const loss = Math.abs(avgLossR);
  const scale = Math.max(win, loss, 0.01);
  // 一勝抵幾敗 — the ratio the two bars encode, computed here as well so a
  // caller with only the averages still gets the sentence.
  const ratio = typeof payoffRatio === "number" ? payoffRatio : loss > 0 ? win / loss : null;
  const healthy = ratio !== null && ratio >= 1;

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="text-neutral-500">賠率結構（實測平均）</span>
        {ratio !== null && (
          <span className={cn("font-mono", healthy ? "text-emerald-400" : "text-amber-400")}>
            一勝抵 {ratio.toFixed(2)} 敗
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className="w-14 shrink-0 text-right font-mono text-[11px] text-red-400/80">
          {avgLossR.toFixed(2)}R
        </span>
        {/* Two half-tracks meeting at a shared zero: the loss grows leftward
            from the centre, the win rightward, both on the same scale. */}
        <div className="flex min-w-0 flex-1 items-center">
          <div className="flex h-2 flex-1 justify-end overflow-hidden rounded-l bg-neutral-800/60">
            <div
              className="h-full rounded-l bg-red-500/60"
              style={{ width: `${(loss / scale) * 100}%` }}
            />
          </div>
          <div className="h-3 w-px shrink-0 bg-neutral-600" />
          <div className="flex h-2 flex-1 overflow-hidden rounded-r bg-neutral-800/60">
            <div
              className="h-full rounded-r bg-emerald-500/60"
              style={{ width: `${(win / scale) * 100}%` }}
            />
          </div>
        </div>
        <span className="w-14 shrink-0 font-mono text-[11px] text-emerald-400/90">
          +{avgWinR.toFixed(2)}R
        </span>
      </div>

      <p className="text-[11px] leading-relaxed text-neutral-500">
        {ratio === null
          ? "樣本裡沒有可比較的勝敗。"
          : healthy
            ? `平均一次獲利 +${avgWinR.toFixed(2)}R、一次虧損 ${avgLossR.toFixed(2)}R —— ` +
              `贏的時候比輸的時候大，勝率不必過半也能是正期望。`
            : `平均一次獲利只有 +${avgWinR.toFixed(2)}R，卻要承受 ${avgLossR.toFixed(2)}R 的虧損 —— ` +
              `這種「小賺大賠」的形狀必須靠高勝率才撐得住，容錯很低。`}
        {typeof scratches === "number" && scratches > 0
          ? ` 另有 ${scratches} 次打平（保本或移停洗出，計入期望值、不計入勝率）。`
          : ""}
      </p>
    </div>
  );
}

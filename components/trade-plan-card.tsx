import type { PlanBacktest, TradePlan } from "@/types/signal";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";

const CONFIDENCE_LABEL: Record<TradePlan["confidence"], string> = {
  high: "信心高",
  medium: "信心中",
  low: "信心低",
};

function Leg({
  label,
  price,
  reason,
  tone,
}: {
  label: string;
  price: number;
  reason: string;
  tone: "entry" | "sl" | "tp";
}) {
  return (
    <div className="flex-1">
      <p className="text-xs text-neutral-500">{label}</p>
      <p
        className={cn(
          "mt-0.5 font-mono text-lg font-bold tabular-nums",
          tone === "entry" && "text-neutral-100",
          tone === "sl" && "text-red-400",
          tone === "tp" && "text-emerald-400",
        )}
      >
        {formatPrice(price)}
      </p>
      <p className="mt-1 text-[11px] leading-snug text-neutral-500">{reason}</p>
    </div>
  );
}

export function TradePlanCard({
  plan,
  backtest,
}: {
  plan: TradePlan;
  backtest: PlanBacktest | null;
}) {
  if (plan.stance === "wait") {
    return (
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/[0.04] p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-base font-bold text-amber-300">觀望</span>
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-400/90">
            現在不進場
          </span>
          <span className="ml-auto text-[11px] text-neutral-600">
            {plan.decided_by === "ai" ? "AI 判斷" : "預設規則"}
          </span>
        </div>
        <p className="text-sm leading-relaxed text-neutral-300">{plan.summary}</p>
        {plan.wait_for && (
          <p className="mt-3 border-t border-amber-500/20 pt-3 text-sm leading-relaxed text-neutral-400">
            <span className="text-neutral-500">等待條件：</span>
            {plan.wait_for}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/[0.04] p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-base font-bold text-emerald-300">進場</span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px]",
            plan.confidence === "high" && "bg-emerald-500/20 text-emerald-300",
            plan.confidence === "medium" && "bg-amber-500/20 text-amber-300",
            plan.confidence === "low" && "bg-neutral-700 text-neutral-300",
          )}
        >
          {CONFIDENCE_LABEL[plan.confidence]}
        </span>
        {plan.risk_reward !== null && (
          <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-300">
            風險報酬比 1:{plan.risk_reward}
          </span>
        )}
        <span className="ml-auto text-[11px] text-neutral-600">
          {plan.decided_by === "ai" ? "AI 判斷" : "預設規則"}
        </span>
      </div>

      <div className="flex gap-3">
        <Leg label="進場" price={plan.entry!} reason={plan.entry_reason} tone="entry" />
        <Leg label="停損" price={plan.stop_loss!} reason={plan.stop_loss_reason} tone="sl" />
        <Leg label="停利" price={plan.take_profit!} reason={plan.take_profit_reason} tone="tp" />
      </div>

      <p className="mt-3 border-t border-neutral-800 pt-3 text-sm leading-relaxed text-neutral-300">
        {plan.summary}
      </p>

      {backtest && backtest.hitRate !== null && (
        <details className="mt-3 border-t border-neutral-800 pt-3">
          <summary className="cursor-pointer list-none text-xs text-neutral-400">
            歷史幾何檢驗：先觸及停利{" "}
            <span
              className={cn(
                "font-mono font-semibold",
                backtest.expectancyR !== null && backtest.expectancyR > 0
                  ? "text-emerald-400"
                  : "text-red-400",
              )}
            >
              {(backtest.hitRate * 100).toFixed(0)}%
            </span>
            {backtest.expectancyR !== null && (
              <span className="ml-2 text-neutral-500">
                期望值 {backtest.expectancyR > 0 ? "+" : ""}
                {backtest.expectancyR}R
              </span>
            )}
            <span className="ml-2 text-neutral-600">n={backtest.resolved}</span>
          </summary>
          <p className="mt-2 text-[11px] leading-relaxed text-neutral-500">
            在近 {backtest.lookbackBars} 根 D1 中，以相同的停損／停利「相對距離」
            逐根回測（最多持有 {backtest.horizonBars} 根）：
            {backtest.wins} 勝 / {backtest.losses} 敗 / {backtest.timeouts} 次未觸及。
          </p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-amber-500/70">
            這檢驗的是「這組距離配置」在本商品波動下的可行性，
            <span className="font-semibold text-amber-400">不是</span>這個訊號的勝率 ——
            回測不分六面向狀態，逐根取樣。
            {backtest.hadAmbiguousBars &&
              " 部分樣本同一根 K 棒同時觸及兩邊，日線無法判斷先後，一律計為敗（偏保守）。"}
          </p>
        </details>
      )}
    </div>
  );
}

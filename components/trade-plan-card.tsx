import type { AddOnLevel, PlanBacktest, TradePlan } from "@/types/signal";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";

const CONFIDENCE_LABEL: Record<TradePlan["confidence"], string> = {
  high: "信心高",
  medium: "信心中",
  low: "信心低",
};

/**
 * 加倉點. Each level shows the stop the whole position moves to when it fills —
 * scaling in without tightening the stop increases risk on a trade that has
 * already paid, which is the one thing adding must never do.
 */
function AddOns({ levels }: { levels: AddOnLevel[] }) {
  return (
    <details className="mt-3 border-t border-neutral-800 pt-3">
      <summary className="cursor-pointer text-xs text-neutral-400 hover:text-neutral-200">
        加倉點（{levels.length} 段，最多 3 段）
      </summary>
      <p className="mt-2 text-[11px] leading-relaxed text-neutral-600">
        只有 A / A+ 才提供加倉點 —— 加倉是押注方向會繼續有效，方向沒信心就不該加。
        每一段都落在強度 ≥2 的結構上（做多有支撐、做空有壓力），不是用 R 倍數推算的價格。
        加倉後停損一律跟著上移。
      </p>
      <ol className="mt-2 space-y-2.5">
        {levels.map((level) => (
          <li key={level.sequence} className="border-l-2 border-emerald-500/40 pl-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs text-neutral-400">第 {level.sequence} 段</span>
              <span className="font-mono text-sm text-neutral-100">{formatPrice(level.price)}</span>
            </div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-neutral-500">{level.reason}</p>
            <div className="mt-1 flex items-baseline justify-between gap-2">
              <span className="text-[11px] text-red-400/80">停損移到</span>
              <span className="font-mono text-xs text-red-400">{formatPrice(level.new_stop_loss)}</span>
            </div>
            <p className="text-[10px] leading-relaxed text-neutral-600">
              {level.new_stop_reason}
              {level.locks_in_entry && (
                <span className="ml-1 text-emerald-500">· 此段成交後已保住進場價</span>
              )}
            </p>
          </li>
        ))}
      </ol>
    </details>
  );
}

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

      {plan.add_ons.length > 0 && <AddOns levels={plan.add_ons} />}

      {plan.swing && (
        <details className="mt-3 border-t border-neutral-800 pt-3">
          <summary className="cursor-pointer text-xs text-neutral-400 hover:text-neutral-200">
            波段變體（較大時間框架）
            <span className="ml-2 font-mono text-neutral-300">
              1:{plan.swing.risk_reward}
            </span>
            {plan.swing.hit_rate !== null && (
              <span className="ml-2 text-neutral-500">
                回測勝率 {(plan.swing.hit_rate * 100).toFixed(0)}%
              </span>
            )}
          </summary>
          <p className="mt-2 text-[11px] leading-relaxed text-neutral-600">
            上方主計畫是當沖（目標 ≤2×ATR）；這裡是同一套分析放到波段的選擇
            —— 目標可到 5×ATR，門檻同樣是實測期望值 ≥ +0.75R 且勝率 ≥55%，且只在 D1 趨勢與方向同向時提供。
            監控與自動復盤只追蹤主計畫，一次一單。
          </p>
          <div className="mt-2 flex gap-3">
            <Leg label="進場" price={plan.swing.entry} reason="" tone="entry" />
            <Leg label="停損" price={plan.swing.stop_loss} reason="" tone="sl" />
            <Leg label="停利" price={plan.swing.take_profit} reason="" tone="tp" />
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-neutral-500">{plan.swing.summary}</p>
        </details>
      )}

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
            {typeof backtest.costPct === "number" && backtest.costPct > 0 && (
              <span className="ml-2 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
                已扣成本 {backtest.costPct}%
              </span>
            )}
          </summary>
          <p className="mt-2 text-[11px] leading-relaxed text-neutral-500">
            以相同的停損／停利「相對距離」逐根回測（最多持有 {backtest.horizonBars} 根）：
            {backtest.wins} 勝 / {backtest.losses} 敗 / {backtest.timeouts} 次未觸及。
            {backtest.basis ? `樣本取法：${backtest.basis}。` : null}
          </p>
          {typeof backtest.costPct === "number" && backtest.costPct > 0 && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-neutral-500">
              勝負是<span className="text-neutral-300">扣掉來回交易成本 {backtest.costPct}%</span>
              之後才認定的 —— 停利要多走這段距離才算贏，停損則多賠這段。
              毛勝率永遠比這個數字好看，而好看的那個沒有人交易得到。
            </p>
          )}
          <p className="mt-1.5 text-[11px] leading-relaxed text-amber-500/70">
            這檢驗的是「這組距離配置」在
            {backtest.conditioned ? "與訊號同向的格局下" : "本商品全部歷史波動下"}
            的可行性，
            <span className="font-semibold text-amber-400">不是</span>這個訊號的勝率 ——
            它只受格局過濾，不受六面向狀態過濾。
            {backtest.hadAmbiguousBars &&
              " 部分樣本同一根 K 棒同時觸及兩邊，日線無法判斷先後，一律計為敗（偏保守）。"}
          </p>
        </details>
      )}
    </div>
  );
}

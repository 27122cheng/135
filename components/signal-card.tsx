import type { TradeSignal } from "@/types/signal";
import { Card, CardContent } from "@/components/ui/card";
import { GradeBadge } from "@/components/grade-badge";
import { DimensionBars } from "@/components/dimension-bars";
import { formatPrice, formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/** True when the pipeline couldn't get a price at all (see buildNoPriceSignal). */
function hasNoPrice(signal: TradeSignal): boolean {
  return signal.entry_zone.low === 0 && signal.entry_zone.high === 0;
}

function PriceRow({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: "entry" | "sl" | "tp";
}) {
  return (
    <details className="group border-b border-neutral-800 last:border-0">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-2.5">
        <span className="flex items-center gap-2 text-sm text-neutral-400">
          <span
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              tone === "entry" && "bg-neutral-400",
              tone === "sl" && "bg-red-500",
              tone === "tp" && "bg-emerald-500",
            )}
          />
          {label}
          <span className="text-xs text-neutral-600 group-open:hidden">▾</span>
        </span>
        <span
          className={cn(
            "text-right font-mono text-base font-semibold tabular-nums",
            tone === "sl" && "text-red-400",
            tone === "tp" && "text-emerald-400",
            tone === "entry" && "text-neutral-100",
          )}
        >
          {value}
        </span>
      </summary>
      <p className="whitespace-pre-line pb-3 text-xs leading-relaxed text-neutral-500">{detail}</p>
    </details>
  );
}

function Section({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <Card>
      <details open={defaultOpen}>
        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-neutral-300">
          {title}
        </summary>
        <div className="px-4 pb-4">{children}</div>
      </details>
    </Card>
  );
}

export function SignalCard({ signal }: { signal: TradeSignal }) {
  const isNoTrade = signal.grade === "no-trade";
  const noPrice = hasNoPrice(signal);
  const entryLabel = noPrice
    ? "無資料"
    : signal.entry_zone.low === signal.entry_zone.high
      ? formatPrice(signal.entry_zone.low)
      : `${formatPrice(signal.entry_zone.low)} – ${formatPrice(signal.entry_zone.high)}`;

  return (
    <div className="flex flex-col gap-3">
      {/* Headline: symbol, direction, grade, and the three prices that matter. */}
      <Card>
        <CardContent className="p-4 pt-4">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-bold text-neutral-100">{signal.symbol}</h2>
              <p className="mt-0.5 text-xs text-neutral-500">
                {formatTime(signal.generated_at)} ·{" "}
                <span
                  className={signal.direction === "long" ? "text-emerald-400" : "text-red-400"}
                >
                  {signal.direction === "long" ? "做多" : "做空"}
                </span>
              </p>
            </div>
            <GradeBadge grade={signal.grade} />
          </div>

          {isNoTrade && (
            <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {noPrice
                ? "無法取得價格資料，此訊號不成立。"
                : "評等為 no-trade，以下價位僅供參考，不構成有效交易訊號。"}
            </p>
          )}

          <div className="rounded-lg border border-neutral-800 bg-neutral-950/50 px-3">
            <PriceRow
              label="進場"
              value={entryLabel}
              detail={signal.entry_zone.reason}
              tone="entry"
            />
            <PriceRow
              label="停損"
              value={noPrice ? "無資料" : formatPrice(signal.stop_loss.price)}
              detail={`${signal.stop_loss.reason}\n結構：${signal.stop_loss.structure}\n失效條件：${signal.stop_loss.invalidation}`}
              tone="sl"
            />
            {signal.take_profits.length === 0 ? (
              <PriceRow
                label="停利"
                value="無"
                detail="path_obstacles 中找不到方向正確的結構，因此不提供停利價位。"
                tone="tp"
              />
            ) : (
              signal.take_profits.map((tp, i) => (
                <PriceRow
                  key={i}
                  label={`停利 TP${i + 1} · ${tp.allocation_pct}%`}
                  value={formatPrice(tp.price)}
                  detail={`${tp.reason}\n結構：${tp.structure}`}
                  tone="tp"
                />
              ))
            )}
          </div>

          <div className="mt-3 flex items-center justify-between text-xs text-neutral-500">
            <span>
              方向分 <span className="font-mono text-neutral-300">{signal.bias_score}</span>
              <span className="mx-1.5 text-neutral-700">+</span>
              結構分 <span className="font-mono text-neutral-300">{signal.entry_structure_score}</span>
            </span>
            <span>
              總分 <span className="font-mono text-base text-neutral-100">{signal.total_score}</span>
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Six dimensions — the main "why", so it stays open. */}
      <Card>
        <CardContent className="p-4 pt-4">
          <p className="mb-3 text-sm font-medium text-neutral-300">六面向分數</p>
          <DimensionBars direction={signal.direction} biasItems={signal.bias_items} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 pt-4">
          <p className="mb-2 text-sm font-medium text-neutral-300">AI 綜合敘述</p>
          <p className="text-sm leading-relaxed text-neutral-300">{signal.narrative}</p>
        </CardContent>
      </Card>

      <Section title={`進場結構（${signal.entry_structures.length}）`}>
        {signal.entry_structures.length === 0 ? (
          <p className="text-xs text-neutral-600">無資料</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {signal.entry_structures.map((s, i) => (
              <li key={i} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-neutral-400">
                  <span className="text-neutral-500">{s.timeframe}</span> {s.type}
                  <span className={s.role === "support" ? "ml-1.5 text-emerald-500" : "ml-1.5 text-red-500"}>
                    {s.role === "support" ? "支撐" : "壓力"}
                  </span>
                  <span className="ml-1.5 text-amber-500">{"★".repeat(s.strength)}</span>
                </span>
                <span className="shrink-0 font-mono text-neutral-300">
                  {formatPrice(s.price)}
                  <span className="ml-1.5 text-neutral-600">{s.distance_pct}%</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`路徑障礙（${signal.path_obstacles.length}）`}>
        {signal.path_obstacles.length === 0 ? (
          <p className="text-xs text-neutral-600">無資料</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {signal.path_obstacles.map((o, i) => {
              const tpIndex = signal.take_profits.findIndex((tp) => tp.price === o.price);
              return (
                <li key={i} className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-neutral-400">
                    <span className="text-neutral-500">{o.timeframe}</span> {o.type}
                    <span className="ml-1.5 text-amber-500">{"★".repeat(o.strength)}</span>
                    {tpIndex >= 0 && (
                      <span className="ml-1.5 rounded bg-emerald-500/20 px-1.5 py-0.5 text-emerald-400">
                        TP{tpIndex + 1}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 font-mono text-neutral-300">{formatPrice(o.price)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title={`全部因子（${signal.bias_items.length}）`}>
        {signal.bias_items.length === 0 ? (
          <p className="text-xs text-neutral-600">無資料</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {signal.bias_items.map((b, i) => (
              <li key={i} className="text-xs leading-relaxed">
                <span
                  className={cn(
                    "mr-1.5 font-medium",
                    b.direction === "long" && "text-emerald-400",
                    b.direction === "short" && "text-red-400",
                    b.direction === "neutral" && "text-neutral-500",
                  )}
                >
                  {b.dimension}
                  {b.weight > 0 && ` ×${b.weight}`}
                </span>
                <span className="text-neutral-300">{b.factor}</span>
                <span className="block text-neutral-600">
                  {b.evidence} · {b.source}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Moved to the bottom and collapsed — it was burying the actual signal. */}
      {signal.data_gaps.length > 0 && (
        <details className="rounded-xl border border-amber-500/30 bg-amber-500/5">
          <summary className="cursor-pointer list-none px-4 py-3 text-sm text-amber-400">
            ⚠ {signal.data_gaps.length} 項資料缺口（點開查看）
          </summary>
          <ul className="list-inside list-disc space-y-1 px-4 pb-4 text-xs leading-relaxed text-amber-300/80">
            {signal.data_gaps.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

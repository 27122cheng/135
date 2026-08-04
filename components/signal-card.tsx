import type { TradeSignal } from "@/types/signal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GradeBadge } from "@/components/grade-badge";
import { DimensionBars } from "@/components/dimension-bars";
import { cn } from "@/lib/utils";

function PriceReasonRow({
  label,
  price,
  reason,
  tone,
}: {
  label: string;
  price: number | string;
  reason: string;
  tone?: "up" | "down" | "neutral";
}) {
  return (
    <details className="group rounded-lg border border-neutral-800 bg-neutral-950/50 px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center justify-between text-sm">
        <span className="text-neutral-400">{label}</span>
        <span
          className={cn(
            "font-mono font-semibold",
            tone === "up" && "text-emerald-400",
            tone === "down" && "text-red-400",
            (!tone || tone === "neutral") && "text-neutral-100",
          )}
        >
          {price}
        </span>
      </summary>
      <p className="mt-2 text-xs leading-relaxed text-neutral-400">{reason}</p>
    </details>
  );
}

export function SignalCard({ signal }: { signal: TradeSignal }) {
  const isNoTrade = signal.grade === "no-trade";

  return (
    <div className="flex flex-col gap-4">
      {signal.data_gaps.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-300">
          <p className="mb-1 font-semibold">⚠ 資料缺口（data_gaps）</p>
          <ul className="list-inside list-disc space-y-0.5">
            {signal.data_gaps.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </div>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle className="text-lg">{signal.symbol}</CardTitle>
            <p className="text-xs text-neutral-500">
              {new Date(signal.generated_at).toLocaleString()} · 方向{" "}
              <span className={signal.direction === "long" ? "text-emerald-400" : "text-red-400"}>
                {signal.direction === "long" ? "做多 LONG" : "做空 SHORT"}
              </span>
            </p>
          </div>
          <GradeBadge grade={signal.grade} />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="outline">bias_score {signal.bias_score}</Badge>
            <Badge variant="outline">entry_structure_score {signal.entry_structure_score}</Badge>
            <Badge variant="outline">total_score {signal.total_score}</Badge>
          </div>

          {isNoTrade && (
            <p className="rounded-lg border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">
              no-trade：以下價位僅供參考，不構成有效交易訊號。
            </p>
          )}

          <div className="grid gap-2 sm:grid-cols-3">
            <PriceReasonRow
              label="進場區間 (entry_zone)"
              price={
                signal.entry_zone.low === signal.entry_zone.high
                  ? signal.entry_zone.low
                  : `${signal.entry_zone.low} ~ ${signal.entry_zone.high}`
              }
              reason={signal.entry_zone.reason}
              tone="neutral"
            />
            <PriceReasonRow
              label="停損 (stop_loss)"
              price={signal.stop_loss.price}
              reason={`${signal.stop_loss.reason}\n結構：${signal.stop_loss.structure}\n失效條件：${signal.stop_loss.invalidation}`}
              tone="down"
            />
            <div className="flex flex-col gap-2">
              {signal.take_profits.length === 0 && (
                <p className="rounded-lg border border-neutral-800 bg-neutral-950/50 px-3 py-2 text-xs text-neutral-500">
                  無停利價位（path_obstacles 中找不到方向正確的結構）
                </p>
              )}
              {signal.take_profits.map((tp, i) => (
                <PriceReasonRow
                  key={i}
                  label={`停利 TP${i + 1} (${tp.allocation_pct}%)`}
                  price={tp.price}
                  reason={`${tp.reason}\n結構：${tp.structure}`}
                  tone="up"
                />
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold text-neutral-400">六面向分數（正負分開顯示）</p>
            <DimensionBars direction={signal.direction} biasItems={signal.bias_items} />
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold text-neutral-400">AI 綜合敘述</p>
            <p className="rounded-lg border border-neutral-800 bg-neutral-950/50 p-3 text-sm leading-relaxed text-neutral-200">
              {signal.narrative}
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-2 text-xs font-semibold text-neutral-400">
                進場結構清單（entry_structures）
              </p>
              <StructureTable
                rows={signal.entry_structures.map((s) => ({
                  price: s.price,
                  type: s.type,
                  role: s.role === "support" ? "支撐" : "壓力",
                  strength: s.strength,
                  distance: `${s.distance_pct}%`,
                }))}
              />
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold text-neutral-400">
                路徑障礙清單（path_obstacles → 對應 TP）
              </p>
              <ObstacleTable signal={signal} />
            </div>
          </div>

          <details className="rounded-lg border border-neutral-800 bg-neutral-950/50 p-3">
            <summary className="cursor-pointer text-xs font-semibold text-neutral-400">
              全部 bias_items（{signal.bias_items.length}）
            </summary>
            <ul className="mt-2 space-y-2">
              {signal.bias_items.map((b, i) => (
                <li key={i} className="text-xs text-neutral-400">
                  <span
                    className={cn(
                      "mr-1 font-semibold",
                      b.direction === "long" && "text-emerald-400",
                      b.direction === "short" && "text-red-400",
                      b.direction === "neutral" && "text-neutral-500",
                    )}
                  >
                    [{b.dimension}/w{b.weight}/{b.direction}]
                  </span>
                  {b.factor} — <span className="text-neutral-500">{b.evidence}</span>{" "}
                  <span className="text-neutral-600">({b.source})</span>
                </li>
              ))}
            </ul>
          </details>
        </CardContent>
      </Card>
    </div>
  );
}

function StructureTable({
  rows,
}: {
  rows: { price: number; type: string; role: string; strength: number; distance: string }[];
}) {
  if (rows.length === 0) {
    return <p className="text-xs text-neutral-600">無資料</p>;
  }
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-800">
      <table className="w-full text-xs">
        <thead className="bg-neutral-900 text-neutral-500">
          <tr>
            <th className="px-2 py-1 text-left">價格</th>
            <th className="px-2 py-1 text-left">類型</th>
            <th className="px-2 py-1 text-left">角色</th>
            <th className="px-2 py-1 text-left">強度</th>
            <th className="px-2 py-1 text-left">距離</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-neutral-800 text-neutral-300">
              <td className="px-2 py-1 font-mono">{r.price}</td>
              <td className="px-2 py-1">{r.type}</td>
              <td className="px-2 py-1">{r.role}</td>
              <td className="px-2 py-1">{"★".repeat(r.strength)}</td>
              <td className="px-2 py-1">{r.distance}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ObstacleTable({ signal }: { signal: TradeSignal }) {
  if (signal.path_obstacles.length === 0) {
    return <p className="text-xs text-neutral-600">無資料</p>;
  }
  const tpByPrice = new Map(signal.take_profits.map((tp, i) => [tp.price, i + 1]));
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-800">
      <table className="w-full text-xs">
        <thead className="bg-neutral-900 text-neutral-500">
          <tr>
            <th className="px-2 py-1 text-left">價格</th>
            <th className="px-2 py-1 text-left">類型</th>
            <th className="px-2 py-1 text-left">時框</th>
            <th className="px-2 py-1 text-left">強度</th>
            <th className="px-2 py-1 text-left">對應TP</th>
          </tr>
        </thead>
        <tbody>
          {signal.path_obstacles.map((o, i) => (
            <tr key={i} className="border-t border-neutral-800 text-neutral-300">
              <td className="px-2 py-1 font-mono">{o.price}</td>
              <td className="px-2 py-1">{o.type}</td>
              <td className="px-2 py-1">{o.timeframe}</td>
              <td className="px-2 py-1">{"★".repeat(o.strength)}</td>
              <td className="px-2 py-1">
                {tpByPrice.has(o.price) ? (
                  <Badge variant="success">TP{tpByPrice.get(o.price)}</Badge>
                ) : (
                  <span className="text-neutral-600">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

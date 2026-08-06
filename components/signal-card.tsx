import Link from "next/link";
import type { NewsDigest, TradeSignal } from "@/types/signal";
import type { AppliedIntervention } from "@/types/journal";
import { Card, CardContent } from "@/components/ui/card";
import { GradeBadge } from "@/components/grade-badge";
import { DimensionBars } from "@/components/dimension-bars";
import { TradePlanCard } from "@/components/trade-plan-card";
import { formatPrice, formatTime } from "@/lib/format";
import { groupDataGaps, KEY_SOURCES } from "@/lib/data-gaps";
import { cn } from "@/lib/utils";
import {
  CONFIDENT_ENTRY_MIN,
  LEVEL_LABEL,
  clearsEntryBar,
  planConfidence,
  takeProfitConfidence,
  type Confidence,
  type ConfidenceLevel,
} from "@/lib/analysis/confidence";

const IMPACT_STYLE: Record<string, { label: string; className: string }> = {
  long: { label: "偏多", className: "bg-emerald-500/15 text-emerald-400" },
  short: { label: "偏空", className: "bg-red-500/15 text-red-400" },
  neutral: { label: "中性", className: "bg-neutral-700 text-neutral-300" },
};

/**
 * What the news actually said, and what the AI made of it.
 *
 * The sentiment score alone was already feeding the 新聞面 dimension, but the
 * headlines behind it and the reasoning over them were never shown — so a
 * number moved the grade and nobody could check it. Each takeaway links to the
 * headlines it was drawn from; the model cites by index into a list we supplied,
 * so a citation can never point at an article that doesn't exist.
 */
function NewsDigestCard({ digest }: { digest: NewsDigest }) {
  const tone =
    digest.score > 0.15 ? "text-emerald-400" : digest.score < -0.15 ? "text-red-400" : "text-neutral-400";
  return (
    <details className="rounded-xl border border-neutral-800 bg-neutral-900/40" open>
      <summary className="cursor-pointer list-none px-4 py-3">
        <span className="text-sm font-medium text-neutral-200">新聞重點</span>
        <span className="ml-2 text-xs text-neutral-500">
          {digest.headline_count} 則 · 情緒分{" "}
          <span className={`font-mono ${tone}`}>{digest.score.toFixed(2)}</span>
        </span>
      </summary>

      <div className="space-y-3 px-4 pb-4">
        <p className="text-xs leading-relaxed text-neutral-300">{digest.summary}</p>

        {digest.key_points.length > 0 && (
          <ul className="space-y-2">
            {digest.key_points.map((k, i) => {
              const style = IMPACT_STYLE[k.impact] ?? IMPACT_STYLE.neutral;
              return (
                <li key={i} className="border-l-2 border-neutral-700 pl-3">
                  <div className="flex items-start gap-2">
                    <span
                      className={`mt-0.5 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] ${style.className}`}
                    >
                      {style.label}
                    </span>
                    <p className="text-xs leading-relaxed text-neutral-200">{k.point}</p>
                  </div>
                  {k.sources.length > 0 && (
                    <p className="mt-1 flex flex-wrap gap-x-2 text-[10px] text-neutral-600">
                      依據：
                      {k.sources.map((idx) => {
                        const src = digest.sources[idx];
                        if (!src) return null;
                        return (
                          <a
                            key={idx}
                            href={src.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline hover:text-neutral-400"
                            title={src.headline}
                          >
                            [{idx}] {src.domain}
                          </a>
                        );
                      })}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <details className="border-t border-neutral-800 pt-2">
          <summary className="cursor-pointer text-[11px] text-neutral-600 hover:text-neutral-400">
            看 {digest.sources.length} 則原始標題
          </summary>
          <ul className="mt-2 space-y-1.5">
            {digest.sources.map((s, i) => (
              <li key={i} className="text-[11px] leading-relaxed">
                <span className="font-mono text-neutral-700">[{i}]</span>{" "}
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-neutral-400 hover:text-neutral-200 hover:underline"
                >
                  {s.headline}
                </a>
                <span className="ml-1 text-neutral-700">
                  — {s.domain} · {s.datetime.slice(5, 16).replace("T", " ")}
                </span>
              </li>
            ))}
          </ul>
        </details>

        <p className="text-[10px] text-neutral-600">
          分析者：{digest.analyzed_by}。只根據上列標題推論，未補充標題以外的事實。
        </p>
      </div>
    </details>
  );
}

/**
 * 本次已套用的干涉 — required by the spec to show not just what was tightened
 * but which past stop-losses caused it, so the constraint is auditable rather
 * than mysterious.
 */
function Interventions({ items }: { items: AppliedIntervention[] }) {
  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-amber-300">本次已套用的干涉</h3>
        <Link href="/review" className="shrink-0 text-[11px] text-neutral-500 hover:text-neutral-300">
          看復盤 →
        </Link>
      </div>
      <p className="mb-2 text-[11px] leading-relaxed text-neutral-500">
        這些是因為過去的停損紀錄自動加嚴的條件。干涉只會降級或收緊，不會放寬。
      </p>
      <ul className="space-y-2">
        {items.map((item, i) => (
          <li key={i} className="border-l-2 border-amber-500/40 pl-3">
            <p className="text-xs text-neutral-200">
              {item.tag && <span className="font-mono text-amber-400">{item.tag} </span>}
              {item.effect}
            </p>
            <p className="mt-0.5 text-[11px] text-neutral-500">{item.evidence}</p>
            {item.triggered_by.length > 0 && (
              <p className="mt-0.5 text-[10px] text-neutral-600">
                觸發來源：{item.triggered_by.join("、")}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DataGaps({ gaps }: { gaps: string[] }) {
  const { missingKeys, keyRelated, other, permanent } = groupDataGaps(gaps);
  // The headline count covers only what someone could actually fix. Permanent
  // limitations are still listed, just not counted as warnings — a number that
  // can never reach zero is a number people stop reading.
  const actionable = keyRelated.length + other.length;
  return (
    <details className="rounded-xl border border-amber-500/30 bg-amber-500/5">
      <summary className="cursor-pointer list-none px-4 py-3 text-sm text-amber-400">
        {actionable > 0 ? `⚠ ${actionable} 項資料缺口` : "資料來源說明"}
        {missingKeys.length > 0 && (
          <span className="ml-1 text-amber-500/70">（{missingKeys.length} 個金鑰未設定）</span>
        )}
        {actionable === 0 && permanent.length > 0 && (
          <span className="ml-1 text-neutral-500">（{permanent.length} 項先天限制，無需處理）</span>
        )}
      </summary>
      <div className="space-y-4 px-4 pb-4">
        {missingKeys.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-amber-300">
              設定以下金鑰即可補上 {keyRelated.length} 項缺口
            </p>
            <ul className="space-y-1 text-xs text-amber-300/80">
              {missingKeys.map((k) => (
                <li key={k}>
                  <code className="text-amber-200">{k}</code>
                  {KEY_SOURCES[k] && <span className="text-amber-400/60"> — {KEY_SOURCES[k]}</span>}
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[11px] text-amber-500/60">
              到{" "}
              <Link href="/settings" className="underline hover:text-amber-300">
                金鑰設定
              </Link>{" "}
              貼上即可，不用重新部署。
            </p>
          </div>
        )}
        {other.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-amber-300">本次取得失敗</p>
            <ul className="list-inside list-disc space-y-1 text-xs leading-relaxed text-amber-300/70">
              {other.map((g, i) => (
                <li key={i}>{g}</li>
              ))}
            </ul>
          </div>
        )}
        {permanent.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-neutral-400">
              先天限制（免費資料源就是沒有，不需處理）
            </p>
            <ul className="list-inside list-disc space-y-1 text-xs leading-relaxed text-neutral-500">
              {permanent.map((g, i) => (
                <li key={i}>{g}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}

/** True when the pipeline couldn't get a price at all (see buildNoPriceSignal). */
function hasNoPrice(signal: TradeSignal): boolean {
  return signal.entry_zone.low === 0 && signal.entry_zone.high === 0;
}


const CONFIDENCE_STYLE: Record<ConfidenceLevel, string> = {
  high: "bg-emerald-500/15 text-emerald-400",
  medium: "bg-amber-500/15 text-amber-400",
  low: "bg-neutral-700/60 text-neutral-400",
};

/**
 * Shows the number and the word, never one without the other.
 *
 * "中" alone hides that 45 and 69 are both 中; "62" alone reads as a
 * probability. Together they say what they are: a ranking with a threshold.
 */

/**
 * Which way the levels point.
 *
 * Repeated here rather than left to the card header because the two are far
 * apart on a phone: by the time you have scrolled to a stop of 1.35300 above an
 * entry of 1.34610, the 做空 that makes those numbers coherent is off-screen,
 * and a stop *above* the entry reads as a mistake instead of a short.
 */
function DirectionChip({ signal }: { signal: TradeSignal }) {
  if (signal.direction_tie) {
    return (
      <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] font-medium text-neutral-400">
        中性
      </span>
    );
  }
  const long = signal.direction === "long";
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[11px] font-medium",
        long ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400",
      )}
    >
      {long ? "做多 ▲" : "做空 ▼"}
    </span>
  );
}

function ConfidenceBadge({ c, compact = false }: { c: Confidence; compact?: boolean }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 font-medium tabular-nums",
        compact ? "text-[10px]" : "text-[11px]",
        CONFIDENCE_STYLE[c.level],
      )}
    >
      {compact ? "" : "信心 "}
      {LEVEL_LABEL[c.level]} {c.score}
    </span>
  );
}

function PriceRow({
  label,
  value,
  detail,
  tone,
  confidence,
}: {
  label: string;
  value: string;
  detail: string;
  tone: "entry" | "sl" | "tp";
  confidence?: Confidence;
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
        <span className="flex items-center gap-2">
          {confidence && <ConfidenceBadge c={confidence} compact />}
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
        </span>
      </summary>
      <div className="pb-3">
        <p className="whitespace-pre-line text-xs leading-relaxed text-neutral-500">{detail}</p>
        {confidence && (
          <ul className="mt-2 space-y-0.5 border-t border-neutral-800/60 pt-2 text-[11px] leading-relaxed text-neutral-600">
            {confidence.factors.map((f, i) => (
              <li key={i}>· {f}</li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

function Section({
  title,
  children,
  defaultOpen = false,
  aside,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  /** Rendered top-right of the header, on the same line as the title. */
  aside?: React.ReactNode;
}) {
  return (
    <Card>
      <details open={defaultOpen}>
        <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 text-sm font-medium text-neutral-300">
          <span>{title}</span>
          {aside && <span className="ml-auto shrink-0">{aside}</span>}
        </summary>
        <div className="px-4 pb-4">{children}</div>
      </details>
    </Card>
  );
}

export function SignalCard({ signal }: { signal: TradeSignal }) {
  const isNoTrade = signal.grade === "no-trade";
  // Computed once and threaded into each target, so every per-target number
  // demonstrably starts from the same base rather than being derived twice.
  // Prefer the stored score: it is the one the entry gate actually used.
  // Recomputing would differ, because withdrawing a plan empties fields the
  // score reads. Older stored signals have none, so fall back to computing.
  const overallConfidence: Confidence = signal.confidence ?? planConfidence(signal);
  const tradeable = clearsEntryBar(overallConfidence.score);
  const noPrice = hasNoPrice(signal);
  const entryLabel = noPrice
    ? "無資料"
    : signal.entry_zone.low === signal.entry_zone.high
      ? formatPrice(signal.entry_zone.low)
      : `${formatPrice(signal.entry_zone.low)} – ${formatPrice(signal.entry_zone.high)}`;

  return (
    <div className="flex flex-col gap-3">
      {/* Headline: symbol, direction, grade. */}
      <Card>
        <CardContent className="p-4 pt-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-bold text-neutral-100">{signal.symbol}</h2>
              <p className="mt-0.5 text-xs text-neutral-500">
                {formatTime(signal.generated_at)} ·{" "}
                {/* A tie means the weighted factors cancelled out. `direction`
                    still carries a value because the geometry needs one, but
                    presenting it as a call would be inventing a view. */}
                <span
                  className={
                    signal.direction_tie
                      ? "text-neutral-400"
                      : signal.direction === "long"
                        ? "text-emerald-400"
                        : "text-red-400"
                  }
                >
                  {signal.direction_tie
                    ? "中性（多空因子相抵，無方向）"
                    : signal.direction === "long"
                      ? "做多"
                      : "做空"}
                </span>
              </p>
            </div>
            <GradeBadge grade={signal.grade} />
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

      {/* The answer: one entry, one stop, one target. */}
      <TradePlanCard plan={signal.trade_plan} backtest={signal.plan_backtest} />

      {signal.interventions.length > 0 && <Interventions items={signal.interventions} />}

      {signal.news_digest && <NewsDigestCard digest={signal.news_digest} />}

      <Section
        title={tradeable ? "完整價位與分批出場" : "參考價位（未達可交易門檻）"}
        aside={
          <span className="flex items-center gap-1.5">
            <DirectionChip signal={signal} />
            <ConfidenceBadge c={overallConfidence} />
          </span>
        }
      >
        {!tradeable && !isNoTrade && (
          <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
            <p className="text-xs text-amber-400">
              方向{" "}
              {signal.direction_tie ? "中性" : signal.direction === "long" ? "做多" : "做空"}
              ，信心度 {overallConfidence.score}，未達可交易門檻 {CONFIDENT_ENTRY_MIN}。
              以下價位是分析算出的真實結構，可以拿來掛單觀察，但這不是建議進場。
            </p>
            <ul className="mt-1.5 space-y-0.5 text-[11px] leading-relaxed text-amber-500/70">
              {overallConfidence.factors.map((f, i) => (
                <li key={i}>· {f}</li>
              ))}
            </ul>
          </div>
        )}
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
                  confidence={takeProfitConfidence(signal, i, overallConfidence)}
                />
              ))
          )}
        </div>
      </Section>

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
      {signal.data_gaps.length > 0 && <DataGaps gaps={signal.data_gaps} />}
    </div>
  );
}

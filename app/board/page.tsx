"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { BoardRow } from "@/app/api/board/route";

/**
 * 交易總覽 — which instruments have a trade right now, at a glance.
 *
 * Two things this page exists to fix.
 *
 * **The wait.** Opening a symbol used to run a full pipeline: candles, COT,
 * yields, news, AI. Nine symbols meant nine of those, one at a time, each time
 * you switched. So this reads what the 4-hourly scan already stored — one
 * query, no analysis — and everything is on screen at once.
 *
 * **The noise.** A signal card is the right thing when you're deciding. It is
 * the wrong thing when the question is "is there anything to do today". A row
 * here says direction, grade and whether there's a trade; opening one adds
 * entry, stop, target and add-ons. Nothing else — no bias items, no
 * structures, no narrative. If you want those, the signal page still has them.
 */

interface BoardResponse {
  rows?: BoardRow[];
  tradeCount?: number;
  scannedCount?: number;
  oldestAt?: string | null;
  error?: string;
  next?: string;
}

const GRADE_STYLE: Record<string, string> = {
  "A+": "bg-emerald-500/20 text-emerald-300",
  A: "bg-emerald-500/15 text-emerald-400",
  B: "bg-sky-500/15 text-sky-400",
  C: "bg-neutral-700/60 text-neutral-300",
  "no-trade": "bg-neutral-800 text-neutral-500",
};

/** Enough precision for FX without turning index levels into noise. */
function fmt(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return Math.abs(n) < 10 ? n.toFixed(5) : n.toFixed(2);
}

function ago(iso: string | null): string {
  if (!iso) return "尚未掃描";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} 小時前` : `${Math.round(h / 24)} 天前`;
}


/**
 * A freshly built signal, in the shape the board draws.
 *
 * Mirrors `toBoardRow` on the server. Kept small and explicit rather than
 * shared through a module: the two inputs genuinely differ — a stored row has
 * an id and a `generated_at` from the database, a fresh one has neither.
 */
function fromSignal(
  base: BoardRow,
  signal: {
    direction: "long" | "short";
    grade: BoardRow["grade"];
    generated_at: string;
    data_gaps?: unknown[];
    trade_plan?: {
      stance?: "enter" | "wait";
      entry?: number | null;
      stop_loss?: number | null;
      take_profit?: number | null;
      risk_reward?: number | null;
      summary?: string;
      wait_for?: string | null;
      add_ons?: Array<{
        sequence: number;
        price: number;
        structure: string;
        new_stop_loss: number;
      }>;
    };
  },
): BoardRow {
  const plan = signal.trade_plan;
  return {
    ...base,
    direction: signal.direction,
    grade: signal.grade,
    stance: plan?.stance ?? null,
    entry: plan?.entry ?? null,
    stopLoss: plan?.stop_loss ?? null,
    takeProfit: plan?.take_profit ?? null,
    riskReward: plan?.risk_reward ?? null,
    addOns: (plan?.add_ons ?? []).map((a) => ({
      sequence: a.sequence,
      price: a.price,
      structure: a.structure,
      new_stop_loss: a.new_stop_loss,
    })),
    summary: plan?.summary ?? null,
    waitFor: plan?.wait_for ?? null,
    generatedAt: signal.generated_at,
    gapCount: Array.isArray(signal.data_gaps) ? signal.data_gaps.length : 0,
  };
}

export default function BoardPage() {
  const [data, setData] = useState<BoardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState<Set<string>>(new Set());
  /** Live results from "全部重新掃描", drawn over the stored rows. */
  const [fresh, setFresh] = useState<Map<string, BoardRow>>(new Map());

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/board");
      const body: BoardResponse = await res.json();
      setData(body);
      setError(res.ok ? null : (body.next ?? body.error ?? "讀取失敗"));
    } catch {
      setError("讀取失敗");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Re-runs every symbol, in parallel, from the browser.
   *
   * Not one server request that loops: nine pipelines do not fit in Vercel
   * Hobby's 60-second function ceiling, and a single long request gives no
   * feedback until it either finishes or dies. Nine independent requests each
   * fit comfortably, and each row updates the moment its own returns.
   *
   * Results are held in memory and drawn over the stored rows rather than
   * written back. `/api/signal` deliberately doesn't persist — pressing this
   * shouldn't append nine rows to the history the /history page reads, and it
   * shouldn't fire the Telegram alerts that a *scheduled* scan is supposed to
   * own. The 4-hourly refresh remains the only thing that writes.
   */
  async function rescanAll() {
    const rows = data?.rows ?? [];
    setRescanning(new Set(rows.map((r) => r.symbol)));
    await Promise.all(
      rows.map(async (row) => {
        try {
          const res = await fetch(`/api/signal/${row.symbol}`, { cache: "no-store" });
          if (res.ok) {
            const signal = await res.json();
            setFresh((prev) => new Map(prev).set(row.symbol, fromSignal(row, signal)));
          }
        } catch {
          // Ignored on purpose: a symbol that failed keeps its stored row,
          // which is older but real.
        } finally {
          setRescanning((prev) => {
            const next = new Set(prev);
            next.delete(row.symbol);
            return next;
          });
        }
      }),
    );
  }

  const stored = data?.rows ?? [];
  const rows = stored.map((r) => fresh.get(r.symbol) ?? r);
  // Trades first, then by grade, then everything else. The question this page
  // answers is "what is actionable", so actionable sorts to the top.
  const order = ["A+", "A", "B", "C", "no-trade"];
  const sorted = [...rows].sort((a, b) => {
    const aTrade = a.stance === "enter" ? 0 : 1;
    const bTrade = b.stance === "enter" ? 0 : 1;
    if (aTrade !== bTrade) return aTrade - bTrade;
    const ga = order.indexOf(a.grade ?? "no-trade");
    const gb = order.indexOf(b.grade ?? "no-trade");
    if (ga !== gb) return ga - gb;
    return a.symbol.localeCompare(b.symbol);
  });

  const trades = sorted.filter((r) => r.stance === "enter");
  const oldest = rows.reduce<string | null>(
    (acc, r) => (r.generatedAt && (!acc || r.generatedAt < acc) ? r.generatedAt : acc),
    null,
  );

  return (
    <main className="mx-auto max-w-2xl px-4 py-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h1 className="text-base font-bold text-neutral-100">交易總覽</h1>
        <nav className="flex shrink-0 gap-3 text-sm text-neutral-500">
          <Link href="/" className="hover:text-neutral-200">
            詳細分析
          </Link>
          <Link href="/setup" className="hover:text-neutral-200">
            通知
          </Link>
        </nav>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
        <span>
          {trades.length > 0 ? (
            <span className="text-emerald-400">{trades.length} 個有交易</span>
          ) : (
            <span>目前沒有可執行的交易</span>
          )}
        </span>
        <span>·</span>
        <span>
          已掃描 {rows.filter((r) => r.generatedAt !== null).length}/{rows.length}
        </span>
        {oldest && (
          <>
            <span>·</span>
            <span>最舊資料 {ago(oldest)}</span>
          </>
        )}
        <button
          type="button"
          onClick={() => void rescanAll()}
          disabled={rescanning.size > 0}
          className="ml-auto rounded-lg border border-neutral-700 px-2.5 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
        >
          {rescanning.size > 0 ? `重新掃描中… 剩 ${rescanning.size}` : "全部重新掃描"}
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-400">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {sorted.map((row) => {
          const isOpen = open === row.symbol;
          const hasTrade = row.stance === "enter";
          const busy = rescanning.has(row.symbol);
          return (
            <div
              key={row.symbol}
              className={`overflow-hidden rounded-xl border ${
                hasTrade ? "border-emerald-500/30 bg-emerald-500/[0.03]" : "border-neutral-800"
              }`}
            >
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : row.symbol)}
                className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-neutral-900/60"
              >
                <span className="w-20 shrink-0 text-sm font-medium text-neutral-100">
                  {row.label}
                </span>

                {row.stance === null ? (
                  <span className="text-xs text-neutral-600">尚未掃描</span>
                ) : hasTrade ? (
                  <>
                    <span
                      className={`shrink-0 text-xs font-medium ${
                        row.direction === "long" ? "text-emerald-400" : "text-red-400"
                      }`}
                    >
                      {row.direction === "long" ? "做多 ▲" : "做空 ▼"}
                    </span>
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        GRADE_STYLE[row.grade ?? "no-trade"]
                      }`}
                    >
                      {row.grade}
                    </span>
                    {row.addOns.length > 0 && (
                      <span className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
                        加倉 {row.addOns.length}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-xs text-neutral-500">觀望</span>
                )}

                <span className="ml-auto shrink-0 text-[10px] text-neutral-600">
                  {busy ? "掃描中…" : ago(row.generatedAt)}
                </span>
                <span className="shrink-0 text-neutral-600">{isOpen ? "▾" : "▸"}</span>
              </button>

              {isOpen && (
                <div className="border-t border-neutral-800/80 px-3 py-2.5 text-xs">
                  {hasTrade ? (
                    <>
                      <dl className="grid grid-cols-3 gap-2">
                        <div>
                          <dt className="text-[10px] text-neutral-600">進場</dt>
                          <dd className="font-mono text-sm text-neutral-100">{fmt(row.entry)}</dd>
                        </div>
                        <div>
                          <dt className="text-[10px] text-neutral-600">止損</dt>
                          <dd className="font-mono text-sm text-red-400">{fmt(row.stopLoss)}</dd>
                        </div>
                        <div>
                          <dt className="text-[10px] text-neutral-600">止盈</dt>
                          <dd className="font-mono text-sm text-emerald-400">
                            {fmt(row.takeProfit)}
                          </dd>
                        </div>
                      </dl>

                      {row.riskReward !== null && (
                        <p className="mt-1.5 text-[11px] text-neutral-500">
                          風報比 1:{row.riskReward}
                        </p>
                      )}

                      {row.addOns.length > 0 ? (
                        <div className="mt-2.5 border-t border-neutral-800/60 pt-2">
                          <p className="mb-1 text-[10px] text-neutral-600">
                            加倉點（{row.addOns.length}，每一筆都會收緊止損）
                          </p>
                          <ul className="flex flex-col gap-1">
                            {row.addOns.map((a) => (
                              <li key={a.sequence} className="flex items-baseline gap-2">
                                <span className="text-[10px] text-neutral-600">#{a.sequence}</span>
                                <span className="font-mono text-neutral-200">{fmt(a.price)}</span>
                                <span className="text-[10px] text-neutral-600">止損→</span>
                                <span className="font-mono text-[11px] text-red-400">
                                  {fmt(a.new_stop_loss)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : (
                        <p className="mt-2 text-[11px] text-neutral-600">
                          無加倉點 —— 沒有結構支撐時不設，這是答案不是遺漏。
                        </p>
                      )}
                    </>
                  ) : row.stance === "wait" ? (
                    <p className="text-neutral-500">
                      觀望{row.waitFor ? `：${row.waitFor}` : ""}
                    </p>
                  ) : (
                    <p className="text-neutral-600">
                      這個商品還沒有掃描紀錄。等下一次排程，或按上面的「全部重新掃描」。
                    </p>
                  )}

                  <div className="mt-2.5 flex items-center gap-3 border-t border-neutral-800/60 pt-2 text-[11px]">
                    <Link
                      href={`/?symbol=${row.symbol}`}
                      className="text-neutral-400 underline hover:text-neutral-200"
                    >
                      完整分析 →
                    </Link>
                    {row.gapCount > 0 && (
                      <span className="text-amber-500/70">{row.gapCount} 項資料缺口</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-4 text-[11px] leading-relaxed text-neutral-600">
        這頁讀的是排程掃描寫進資料庫的結果，所以是即開即有，不會每換一個商品就重跑一次分析。
        資料新舊看每一列右邊的時間；要立刻更新就按「全部重新掃描」，九個商品會同時跑。
      </p>
    </main>
  );
}

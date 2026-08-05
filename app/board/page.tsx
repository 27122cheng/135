"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { BoardRow } from "@/app/api/board/route";
import { userKeyHeaders } from "@/lib/user-keys-client";

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

/** Cheap: one query. */
const READ_INTERVAL_MS = 60_000;
/** Expensive: nine pipelines. Matches the 5-minute position monitor. */
const SCAN_INTERVAL_MS = 5 * 60_000;

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


export default function BoardPage() {
  const [data, setData] = useState<BoardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState<Set<string>>(new Set());
  const [autoScan, setAutoScan] = useState(true);
  // The scan timer must see the newest rows without being torn down and
  // rebuilt every time they change — that would reset the 5-minute clock on
  // every poll and the rescan would never fire.
  const dataRef = useRef<BoardResponse | null>(null);

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
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    void load();
  }, [load]);



  /**
   * Re-runs symbols in parallel, storing each result.
   *
   * Parallel from the browser rather than one looping server request: nine
   * pipelines do not fit in Vercel Hobby's 60-second ceiling, and a single long
   * request gives no feedback until it finishes or dies.
   *
   * Each result is **written**, then the whole board is re-read from the
   * database. That extra round trip is the point: the board and the detail page
   * now render the same stored row, so they cannot disagree. Previously each
   * built its own copy, and since the AI picks `stance`, the same symbol could
   * legitimately come back 觀望 in one view and a full entry in the other.
   */
  const rescan = useCallback(
    async (targets: BoardRow[]) => {
      if (targets.length === 0) return;
      setRescanning(new Set(targets.map((r) => r.symbol)));
      await Promise.all(
        targets.map(async (row) => {
          try {
            await fetch(`/api/scan?symbol=${row.symbol}`, {
              cache: "no-store",
              headers: userKeyHeaders(),
            });
          } catch {
            // Ignored: a symbol that failed keeps its stored row, which is
            // older but real. The reload below is the source of truth.
          } finally {
            setRescanning((prev) => {
              const next = new Set(prev);
              next.delete(row.symbol);
              return next;
            });
          }
        }),
      );
      await load();
    },
    [load],
  );

  /**
   * Scan on open, not just on the timer.
   *
   * Reading the stored rows is instant, but the numbers in them are as old as
   * the last scan — which, with GitHub's scheduler running the "5-minute"
   * monitor about hourly, can be a long time. Opening the board is the clearest
   * possible statement of "show me where things stand now", so it starts a real
   * scan immediately rather than displaying an hour-old picture and waiting five
   * minutes to improve it.
   *
   * Still filtered by staleness: a row the scheduler refreshed forty seconds
   * ago is not rebuilt because someone reloaded the page. Nine pipelines per
   * refresh would exhaust the free AI quota in an afternoon of browsing.
   */
  const kicked = useRef(false);
  useEffect(() => {
    if (kicked.current || !autoScan) return;
    const rows = data?.rows;
    if (!rows || rows.length === 0) return;
    kicked.current = true;

    const cutoff = Date.now() - SCAN_INTERVAL_MS;
    const stale = rows.filter(
      (r) => !r.generatedAt || new Date(r.generatedAt).getTime() < cutoff,
    );
    if (stale.length > 0) void rescan(stale);
  }, [data, autoScan, rescan]);

  /**
   * Keeps the board current without anyone pressing anything.
   *
   * Two different clocks, because the two jobs cost wildly different amounts.
   * Re-reading the stored rows is one database query, so it runs often. A full
   * rescan is nine analysis pipelines and burns free-tier AI quota, so it runs
   * on the 5-minute tick and only over rows that are actually older than that
   * — a symbol the scheduler just refreshed is not rebuilt for the sake of it.
   *
   * Both stop when the tab is hidden. A dashboard left open in a background
   * tab overnight would otherwise spend the whole daily quota on a screen
   * nobody is looking at.
   */
  useEffect(() => {
    if (!autoScan) return;
    const visible = () => document.visibilityState === "visible";

    const readTimer = setInterval(() => {
      if (visible()) void load();
    }, READ_INTERVAL_MS);

    const scanTimer = setInterval(() => {
      if (!visible()) return;
      const cutoff = Date.now() - SCAN_INTERVAL_MS;
      const stale = (dataRef.current?.rows ?? []).filter(
        (r) => !r.generatedAt || new Date(r.generatedAt).getTime() < cutoff,
      );
      if (stale.length > 0) void rescan(stale);
    }, SCAN_INTERVAL_MS);

    return () => {
      clearInterval(readTimer);
      clearInterval(scanTimer);
    };
  }, [autoScan, load, rescan]);

  const rows = data?.rows ?? [];
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
        <label className="ml-auto flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px] text-neutral-500">
          <input
            type="checkbox"
            checked={autoScan}
            onChange={(e) => setAutoScan(e.target.checked)}
            className="h-3 w-3 accent-emerald-500"
          />
          每 5 分鐘自動掃描
        </label>
        <button
          type="button"
          onClick={() => void rescan(rows)}
          disabled={rescanning.size > 0}
          className="shrink-0 rounded-lg border border-neutral-700 px-2.5 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
        >
          {rescanning.size > 0 ? `掃描中… 剩 ${rescanning.size}` : "立即全部掃描"}
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

      <div className="mt-4 space-y-1.5 text-[11px] leading-relaxed text-neutral-600">
        <p>
          這頁與詳細分析頁讀的是<span className="text-neutral-400">同一筆</span>資料庫紀錄，
          所以兩邊不可能講不同的話。掃描結果會寫回資料庫，不是各自算各自的。
        </p>
        <p>
          <span className="text-neutral-400">打開這頁就會立刻掃描一次</span>，
          之後每分鐘重讀資料庫（便宜）、每 5 分鐘重跑分析（九條完整管線，會用掉免費 AI 額度）。
          兩者都只重跑<span className="text-neutral-400">超過 5 分鐘沒更新</span>的商品 ——
          排程四十秒前才更新過的，不會因為你重新整理一次頁面就重算。
          分頁切到背景就暫停：沒人在看的畫面不該把一天的額度燒光。
        </p>
      </div>
    </main>
  );
}

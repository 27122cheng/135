"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { BoardRow } from "@/app/api/board/route";
import { usdExposure } from "@/lib/board-row";
import { SiteNav } from "@/components/site-nav";
import { EconomicCountdown } from "@/components/economic-countdown";
import { userKeyHeaders } from "@/lib/user-keys-client";
import { CONFIDENT_ENTRY_MIN } from "@/lib/analysis/confidence";

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
  /** Which table answered — "signals" means latest_signal was empty. */
  source?: "latest_signal" | "signals";
  /** Set when the board is running off a fallback the owner should fix. */
  note?: string | null;
  /** Short commit sha of the deployed build, so "did it deploy" is answerable. */
  build?: string | null;
  /** Which database host answered — the fact that catches a per-deploy branch. */
  db?: { kind: string; host: string; database: string | null } | null;
  error?: string;
  next?: string;
}

/** Cheap: one query. */
const READ_INTERVAL_MS = 60_000;
/**
 * Expensive: nine pipelines, each making AI calls.
 *
 * 5 minutes → 30 minutes → 4 hours, and each cut was forced by the same
 * evidence. At 5 minutes nine symbols burned 98,299 of Groq's 100,000 free
 * daily tokens in an afternoon. At 30 minutes it still did: the live board
 * came back with `Used 98,565` on Groq and a 429 on Gemini, so every signal
 * had silently fallen back to local rules while still looking like a full
 * analysis on screen.
 *
 * 4 hours is not a budget compromise, it is the honest interval. The whole
 * analysis is built on the H4 candle; inside one bar the inputs have not
 * moved — same candles, same COT (weekly), same yields (daily) — so a rescan
 * buys a differently-worded answer to identical facts. It is also exactly what
 * the scheduled refresh already does for all nine symbols, which means the
 * browser was re-running work that had just been done, eight times over, and
 * paying for it with the budget that made the *scheduled* run work.
 *
 * 立即全部掃描 is still there for when you actually want it now. The position
 * monitor still runs on its own 5-minute server-side clock — that one reads a
 * cached quote and costs no AI at all, which is why it can be frequent.
 */
const SCAN_INTERVAL_MS = 4 * 60 * 60_000;
/**
 * How many symbols to analyse at once.
 *
 * Nine in parallel breaches a 10-requests-per-minute provider limit on the
 * first tick, every tick. Two at a time keeps a sweep inside the rate limit and
 * costs only wall-clock time, which nobody is watching.
 */
const SCAN_CONCURRENCY = 2;
/**
 * How long to wait for one symbol before calling it failed.
 *
 * `/api/scan` declares `maxDuration = 60`, so a request still open past that is
 * one Vercel has already killed. Slightly over the ceiling so a function that
 * finishes at 58 seconds still counts, and the extra five seconds are for the
 * round trip on a phone.
 */
const SCAN_TIMEOUT_MS = 65_000;

/**
 * `AbortSignal.timeout`, with a fallback.
 *
 * Not defensive programming for its own sake: this page is used from a phone
 * browser, and `AbortSignal.timeout` only arrived in Safari 16. Calling it
 * where it doesn't exist throws a TypeError *before* the fetch is made, which
 * would turn "one symbol was slow" into "every scan fails instantly" on any
 * older device — a much worse failure than the one it is here to catch.
 */
function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), ms);
  return controller.signal;
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
  // "尚未掃描" used to live here as well as on the stance chip, so a row with no
  // record said it twice and a row that *had* been scanned but produced no plan
  // still said it once — which read as "the scan never ran" when the truth was
  // "the scan ran and found nothing to do". The two states are now spelled
  // differently everywhere: this column is only ever about time.
  if (!iso) return "無紀錄";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} 小時前` : `${Math.round(h / 24)} 天前`;
}


/**
 * 參考價位 on a row that has no trade — when one was actually selected.
 *
 * This block used to render on every scanned row, because the levels it drew
 * from (entry zone, nearest protecting structure, nearest obstacles) are always
 * populated. Nothing had chosen them: no hit-rate floor, no payoff floor, no
 * backtest. So the board printed an entry, a stop and a target for instruments
 * the rules had just refused to trade, and the quieter styling did not stop
 * anyone reading three prices as a plan.
 *
 * It now renders only when `reference_plan` exists — the geometry the same
 * search picked at the lower reference bar (回測勝率 ≥55%、風報比 ≥1:1.5).
 * When that comes back empty the row says 無交易 instead, matching the detail
 * card exactly.
 */
function ReferenceLevels({ row }: { row: BoardRow }) {
  const ref = row.reference;
  if (!ref) {
    // Returning null here is what made this impossible to diagnose from a
    // screenshot: a build without the feature and a row whose stored signal
    // has no usable stop price look identical — both show nothing at all.
    if (row.generatedAt === null) return null;
    return (
      <p className="mt-2.5 text-[11px] leading-relaxed text-neutral-600">
        {/* Two floors, in order: the trade recommendation needs a combination
            whose *managed* backtest (breakeven, trailing, CHoCH exit — the
            rules the monitor actually runs) shows expectancy ≥ +0.75R and a
            hit rate ≥55%; 參考價位 is the consolation tier at a flat ≥55%. A
            row with neither failed BOTH — saying only "the 55% floor" made
            the two messages on one row look like they disagreed. */}
        無交易：分析找到的每一組價位都被統計附加審查否決（實測期望值 &lt;0 或勝率 &lt;40% 才否決
        —— 附加審查只擋明顯不利，門檻本身由分析決定）——
        {row.referenceNote ? `${row.referenceNote}。` : "因此不提供任何價位。"}
      </p>
    );
  }

  const zone =
    ref.entryLow === ref.entryHigh
      ? fmt(ref.entryLow)
      : `${fmt(ref.entryLow)} – ${fmt(ref.entryHigh)}`;
  const dir = row.directionTie ? "中性" : row.direction === "long" ? "做多" : "做空";
  const dirTone = row.directionTie
    ? "text-neutral-400"
    : row.direction === "long"
      ? "text-emerald-400/70"
      : "text-red-400/70";

  return (
    <div className="mt-2.5 rounded-lg border border-neutral-800 bg-neutral-950/60 px-2.5 py-2">
      <p className="mb-1.5 flex items-baseline gap-2 text-[10px] text-neutral-500">
        <span>參考價位</span>
        <span className={dirTone}>{dir}</span>
        <span className="text-neutral-600">已通過回測與風報比門檻，但未達可交易評等</span>
      </p>
      <dl className="grid grid-cols-3 gap-2">
        <div>
          <dt className="text-[10px] text-neutral-600">進場區</dt>
          <dd className="font-mono text-[13px] text-neutral-300">{zone}</dd>
        </div>
        <div>
          <dt className="text-[10px] text-neutral-600">止損</dt>
          <dd className="font-mono text-[13px] text-red-400/80">{fmt(ref.stopLoss)}</dd>
        </div>
        <div>
          <dt className="text-[10px] text-neutral-600">止盈</dt>
          <dd className="font-mono text-[13px] text-emerald-400/80">
            {ref.takeProfits.length === 0 ? "無" : fmt(ref.takeProfits[0].price)}
          </dd>
        </div>
      </dl>
      {ref.takeProfits.length > 1 && (
        <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-neutral-500">
          {ref.takeProfits.slice(1).map((tp, i) => (
            <li key={i}>
              <span className="text-neutral-600">TP{i + 2} · {tp.allocationPct}%</span>{" "}
              <span className="font-mono text-neutral-400">{fmt(tp.price)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1.5 text-[10px] leading-relaxed text-neutral-600">
        {ref.entryReason}
        {ref.stopReason ? `｜止損結構：${ref.stopReason}` : ""}
      </p>
    </div>
  );
}

/**
 * 持倉一眼 — the board answers "有什麼新交易", but a reader managing money
 * opens it with a prior question: "我現在抱著什麼". Until now the answer
 * lived on a different page, so a held position was invisible from the very
 * screen where new entries are decided — and the correlation between a new
 * entry and an existing position is exactly what a desk checks first.
 */
interface HeldStripRow {
  symbol: string;
  state: string;
  direction: "long" | "short" | null;
  openR: number | null;
  paper: boolean;
}

function HeldStrip() {
  const [held, setHeld] = useState<HeldStripRow[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/positions", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { open?: HeldStripRow[] };
        if (!cancelled) setHeld((body.open ?? []).filter((p) => !p.paper));
      } catch {
        // The board must render whether or not the positions read works.
      }
    };
    void load();
    const timer = setInterval(load, 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!held || held.length === 0) return null;
  return (
    <Link
      href="/positions"
      className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.04] px-3 py-2 text-xs hover:bg-emerald-500/[0.08]"
    >
      <span className="font-medium text-emerald-300">持倉中 {held.length} 筆</span>
      {held.map((h) => (
        <span key={h.symbol} className="flex items-center gap-1 text-neutral-300">
          {h.symbol}
          <span className={h.direction === "long" ? "text-emerald-400" : "text-red-400"}>
            {h.direction === "long" ? "▲" : "▼"}
          </span>
          {h.state === "scaled" && <span className="text-[10px] text-emerald-500">半倉</span>}
          {h.openR !== null && (
            <span
              className={`font-mono text-[11px] ${h.openR > 0 ? "text-emerald-400" : h.openR < 0 ? "text-red-400" : "text-neutral-500"}`}
            >
              {h.openR > 0 ? "+" : ""}
              {h.openR}R
            </span>
          )}
        </span>
      ))}
      <span className="ml-auto text-neutral-500">管理 →</span>
    </Link>
  );
}

export default function BoardPage() {
  const [data, setData] = useState<BoardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState<Set<string>>(new Set());
  const [autoScan, setAutoScan] = useState(true);
  /**
   * Why each symbol's scan did not produce a row, keyed by symbol.
   *
   * Was a single string, set only from `body.storeError` / `body.error`. That
   * covered exactly one of the four ways a scan can fail and silently dropped
   * the other three — a non-2xx status, a body that isn't JSON (Vercel's
   * 504 `FUNCTION_INVOCATION_TIMEOUT` page is HTML), and a fetch that throws.
   * All three left the row at 無紀錄 with an empty screen and no clue, which is
   * precisely the state this page kept being reported in.
   */
  const [scanErrors, setScanErrors] = useState<Record<string, string>>({});
  // The scan timer must see the newest rows without being torn down and
  // rebuilt every time they change — that would reset the 5-minute clock on
  // every poll and the rescan would never fire.
  const dataRef = useRef<BoardResponse | null>(null);

  const load = useCallback(async (): Promise<BoardResponse | null> => {
    try {
      // `no-store` is not optional here. Without it the browser happily serves
      // the first response — an empty board, taken before anything had been
      // scanned — back to every later reload, so scans wrote rows nobody ever
      // saw and the header read 已掃描 0/9 indefinitely. The route is
      // force-dynamic on the server; that says nothing about the client cache.
      const res = await fetch("/api/board", { cache: "no-store" });
      const body: BoardResponse = await res.json();
      setData(body);
      setError(res.ok ? null : (body.next ?? body.error ?? "讀取失敗"));
      return body;
    } catch {
      setError("讀取失敗");
      return null;
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
      const startedAt = Date.now();
      setScanErrors({});
      setRescanning(new Set(targets.map((r) => r.symbol)));
      const failures = new Set<string>();

      const fail = (symbol: string, why: string) => {
        failures.add(symbol);
        setScanErrors((prev) => ({ ...prev, [symbol]: why }));
      };

      // A small worker pool rather than Promise.all over all nine. Same total
      // work, but it arrives at a rate the free AI tiers accept instead of as
      // one burst that trips the per-minute limit and drops eight of them onto
      // the local-rule fallback.
      const queue = [...targets];
      const worker = async () => {
        for (;;) {
          const row = queue.shift();
          if (!row) return;
          try {
            // A hard client-side deadline. Without it a request that never
            // answers leaves the row spinning forever and the pool wedged on
            // it, which looks exactly like "the scan is still working" — the
            // most expensive possible way to say nothing.
            const res = await fetch(`/api/scan?symbol=${row.symbol}`, {
              cache: "no-store",
              headers: userKeyHeaders(),
              signal: timeoutSignal(SCAN_TIMEOUT_MS),
            });
            // Read as text first. A Vercel function that blows its 60-second
            // ceiling answers 504 with an HTML page, and `res.json()` on that
            // throws — which the old `.catch(() => null)` turned into "no
            // error", i.e. a silent failure indistinguishable from success.
            const raw = await res.text();
            let body: { error?: string; storeError?: string; stored?: boolean } | null = null;
            try {
              body = JSON.parse(raw);
            } catch {
              body = null;
            }

            if (!res.ok) {
              fail(
                row.symbol,
                body?.error ??
                  (res.status === 504
                    ? "分析超過 60 秒，Vercel 中斷了這次請求"
                    : `HTTP ${res.status}`),
              );
            } else if (body === null) {
              fail(row.symbol, "伺服器回傳的不是 JSON（多半是逾時或崩潰頁）");
            } else if (body.storeError) {
              // The scan ran but the result could not be stored — the board
              // would stay at 無紀錄 forever with the analysis silently thrown
              // away.
              fail(row.symbol, body.storeError);
            } else if (body.error) {
              fail(row.symbol, body.error);
            }
          } catch (err) {
            // Not ignorable. A symbol whose scan threw has no stored row to
            // fall back on, and swallowing this is how nine failed scans
            // produced a blank board with no explanation anywhere.
            const name = err instanceof Error ? err.name : "";
            fail(
              row.symbol,
              name === "TimeoutError" || name === "AbortError"
                ? `等超過 ${Math.round(SCAN_TIMEOUT_MS / 1000)} 秒沒有回應`
                : err instanceof Error
                  ? err.message
                  : String(err),
            );
          } finally {
            setRescanning((prev) => {
              const next = new Set(prev);
              next.delete(row.symbol);
              return next;
            });
            // Re-read after each symbol, not only when all nine finish. A
            // full sweep at two-at-a-time takes minutes; showing nothing until
            // the last one lands is indistinguishable from being broken, which
            // is exactly how this looked.
            await load();
          }
        }
      };
      await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
      const after = await load();

      // The check that would have caught a day of silent data loss: a scan
      // that reported "stored" must be visible in the very next read. When the
      // re-read still shows a row from before the scan started, the write went
      // to a database this page's reads never see (or was dropped) — a state
      // the old code rendered as a *success* with day-old timestamps, leaving
      // 「重整完為什麼還是舊資料」 with no on-screen answer. Ten minutes of
      // slack so a phone clock a few minutes off cannot fake a failure.
      if (after?.rows) {
        const cutoff = startedAt - 10 * 60_000;
        for (const target of targets) {
          if (failures.has(target.symbol)) continue;
          const row = after.rows.find((r) => r.symbol === target.symbol);
          const at = row?.generatedAt ? Date.parse(row.generatedAt) : NaN;
          if (Number.isFinite(at) && at < cutoff) {
            fail(
              target.symbol,
              "掃描回報已儲存，但重新讀取資料庫拿到的仍是舊資料 —— 寫入被丟棄，" +
                "或這個部署連到的資料庫和讀取的不是同一顆（見頁尾的資料庫主機名稱）",
            );
          }
        }
      }
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
  const usdCluster = usdExposure(sorted);
  const failedSymbols = Object.keys(scanErrors);
  const oldest = rows.reduce<string | null>(
    (acc, r) => (r.generatedAt && (!acc || r.generatedAt < acc) ? r.generatedAt : acc),
    null,
  );

  return (
    <main className="mx-auto max-w-2xl px-4 py-5">
      <SiteNav title="交易總覽" />

      {/* 重整 sits with the status line it acts on, not in the nav bar: the
          nav is now identical on every page, and a control that exists on
          exactly one of them cannot live inside it. */}
      <div className="mb-3 flex items-center justify-end">
        <button
          type="button"
          onClick={() => void rescan(rows)}
          disabled={rescanning.size > 0}
          className="rounded-lg border border-neutral-700 px-2.5 py-1 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-40"
        >
          {rescanning.size > 0 ? `重整中… 剩 ${rescanning.size}` : "↻ 重整全部商品"}
        </button>
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
          每 4 小時自動掃描
        </label>
      </div>

      <HeldStrip />

      <EconomicCountdown />

      {error && (
        <div className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-400">
          {error}
        </div>
      )}
      {data?.note && (
        <div className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-400">
          {data.note}
        </div>
      )}
      {usdCluster && (
        <div className="mb-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-300">
          <p className="font-medium">
            ⚠ 美元同向曝險：{usdCluster.symbols.join("、")} 的進場訊號實質上都是
            {usdCluster.side === "long" ? "做多" : "做空"}美元
          </p>
          <p className="mt-1 leading-relaxed text-amber-400/80">
            同時進場等於同一個宏觀方向開 {usdCluster.symbols.length} 倍槓桿。
            這一組的部位風險應合併當作一筆計算（例如各單部位除以 {usdCluster.symbols.length}），
            而不是各自獨立配置。
          </p>
        </div>
      )}
      {failedSymbols.length > 0 && (
        <div className="mb-3 rounded-xl border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-300">
          <p className="font-medium">{failedSymbols.length} 個商品掃描失敗</p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {failedSymbols.map((symbol) => (
              <li key={symbol} className="flex gap-2">
                <span className="w-16 shrink-0 text-red-400/70">{symbol}</span>
                <span className="break-all text-red-300/90">{scanErrors[symbol]}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-red-400/70">
            存不進去有兩種：<code>latest_signal</code> 資料表還沒建立（到{" "}
            <Link href="/setup" className="underline">
              設定頁
            </Link>{" "}
            按「建立資料表」），或寫入被默默丟棄 ——
            後者幾乎都是資料庫整合替每個部署開了新分支，把 DATABASE_URL
            換成固定分支的連線字串即可。逾時則是資料來源太慢，重按一次通常會過，因為第二次讀的是快取。
          </p>
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

                {scanErrors[row.symbol] ? (
                  <span className="text-xs text-red-400">掃描失敗</span>
                ) : row.stance === null ? (
                  // "目前無交易", not "尚未掃描". A stored row with no plan is a
                  // finished scan that decided there is nothing to take; only
                  // the timestamp column is qualified to say whether a scan
                  // ever ran, and it does.
                  <span className="text-xs text-neutral-500">目前無交易</span>
                ) : hasTrade ? (
                  <>
                    <span
                      className={`shrink-0 text-xs font-medium ${
                        row.directionTie
                          ? "text-neutral-400"
                          : row.direction === "long"
                            ? "text-emerald-400"
                            : "text-red-400"
                      }`}
                    >
                      {row.directionTie
                        ? "中性"
                        : row.direction === "long"
                          ? "做多 ▲"
                          : "做空 ▼"}
                    </span>
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        GRADE_STYLE[row.grade ?? "no-trade"]
                      }`}
                    >
                      {row.grade}
                    </span>
                    {row.confidence !== null && (
                      <span className="shrink-0 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-400/80">
                        信心 {row.confidence}
                      </span>
                    )}
                    {row.addOns.length > 0 && (
                      <span className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
                        加倉 {row.addOns.length}
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    <span className="text-xs text-neutral-500">觀望</span>
                    {row.confidence !== null && (
                      <span className="shrink-0 text-[10px] text-neutral-600">
                        信心 {row.confidence}/{CONFIDENT_ENTRY_MIN}
                      </span>
                    )}
                  </>
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

                      <p className="mt-1.5 flex flex-wrap gap-x-3 text-[11px] text-neutral-500">
                        {row.riskReward !== null && <span>風報比 1:{row.riskReward}</span>}
                        {/* The evidence next to the advice: the managed
                            backtest that let this plan pass the floors. A
                            recommendation without its sample size asks to be
                            trusted; this one shows its work. */}
                        {row.planEvidence && (
                          <span
                            className={
                              (row.planEvidence.expectancyR ?? 0) > 0
                                ? "text-emerald-500/80"
                                : "text-neutral-500"
                            }
                          >
                            實測{" "}
                            {row.planEvidence.expectancyR !== null &&
                              `期望值 ${row.planEvidence.expectancyR > 0 ? "+" : ""}${row.planEvidence.expectancyR}R`}
                            {row.planEvidence.hitRate !== null &&
                              `・勝率 ${Math.round(row.planEvidence.hitRate * 100)}%`}
                            ・{row.planEvidence.resolved} 筆樣本
                          </span>
                        )}
                      </p>

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
                  ) : (
                    <>
                      {scanErrors[row.symbol] ? (
                        <p className="text-red-300">
                          這次掃描失敗：{scanErrors[row.symbol]}
                        </p>
                      ) : row.generatedAt === null ? (
                        <p className="text-neutral-600">
                          這個商品還沒有掃描紀錄。等下一次排程，或按上面的「立即全部掃描」。
                        </p>
                      ) : (
                        <p className="text-neutral-500">
                          {row.stance === "wait" ? "觀望" : "目前無交易"}
                          {row.waitFor ? `：${row.waitFor}` : ""}
                        </p>
                      )}
                      <ReferenceLevels row={row} />
                    </>
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
          <span className="text-neutral-400">打開這頁會掃描一次</span>，
          之後每分鐘重讀資料庫（便宜）、每 4 小時重跑分析。
          兩者都只動<span className="text-neutral-400">超過 4 小時沒更新</span>的商品，
          一次只跑 2 個。分頁切到背景就暫停。想馬上要就按「立即全部掃描」。
        </p>
        <p className="text-amber-500/70">
          間隔從 5 分鐘改成 30 分鐘、再改成 4 小時，每一次都是被同一份證據逼的：
          實測 Groq 每日 10 萬 token 還是會用光（Used 98,565），Gemini 429
          —— 之後每筆訊號都悄悄退回本地規則，畫面上看起來卻跟正常分析一樣。
          4 小時不是省錢的妥協，是誠實的間隔：整套分析建在 H4 K 棒上，同一根
          K 棒內輸入根本沒變，重跑只會換一種說法講同一組事實。排程本來就每 4
          小時掃完九個商品，瀏覽器等於在重做剛做完的事，還花掉讓排程能跑的額度。
        </p>
        {/* So "the fix didn't work" and "the fix isn't deployed yet" stop
            looking the same from a phone screenshot. */}
        <p className="text-neutral-700">
          版本 {data?.build ?? "本機"}
          {data?.source ? `．資料來源 ${data.source}` : ""}
          {/* The database *host*. If this string is different in two
              screenshots, the mystery of "writes succeed, board stays old"
              is solved: they were different databases. */}
          {data?.db ? `．資料庫 ${data.db.host}` : ""}
        </p>
      </div>
    </main>
  );
}

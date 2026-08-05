"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { COMMODITIES, type CommodityMeta, type TradeSignal } from "@/types/signal";
import { CommodityList } from "@/components/commodity-list";
import { SignalCard } from "@/components/signal-card";
import { loadCustomSymbols, toCommodityMeta, type CustomSymbol } from "@/lib/custom-symbols";
import { userKeyHeaders } from "@/lib/user-keys-client";

export default function Home() {
  const [selected, setSelected] = useState<string>("XAUUSD");
  const [custom, setCustom] = useState<CustomSymbol[]>([]);
  const [signal, setSignal] = useState<TradeSignal | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  /** True while the first build for a never-scanned symbol is running. */
  const [stale, setStale] = useState(false);

  useEffect(() => {
    setCustom(loadCustomSymbols());
    // Deep link from 交易總覽, so "完整分析 →" lands on the right instrument
    // instead of whatever was selected last. Read once on mount: after that the
    // list is in charge, and rewriting the URL on every click would fight it.
    const wanted = new URLSearchParams(window.location.search).get("symbol");
    if (wanted) setSelected(wanted.toUpperCase());
  }, []);

  const symbols: CommodityMeta[] = useMemo(
    () => [...COMMODITIES, ...custom.map(toCommodityMeta)],
    [custom],
  );

  /**
   * Stored first, build only on request.
   *
   * This used to run a full pipeline on every symbol change: 10–30 seconds of
   * waiting each time, and — worse — a *second* independent build of a symbol
   * the board had already built. Since the AI chooses the trade plan's stance,
   * two builds could disagree, and they did: the board showed an entry while
   * this page showed 觀望, both stamped the same minute.
   *
   * So both views now read the same stored row. Rebuilding is an explicit
   * action, and it writes, so the two stay in agreement afterwards too.
   */
  const loadStored = useCallback(async () => {
    const customEntry = custom.find((c) => c.symbol === selected);
    if (customEntry) return null; // custom symbols are never stored
    try {
      // The board's own endpoint, filtered — same `latest_signal` row the board
      // draws, so the two literally cannot show different numbers.
      const res = await fetch(`/api/board?symbol=${selected}`, { cache: "no-store" });
      if (!res.ok) return null;
      const body = await res.json();
      return (body.signal as TradeSignal | undefined) ?? null;
    } catch {
      return null;
    }
  }, [selected, custom]);

  const rebuild = useCallback(async () => {
    setBuilding(true);
    setError(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 70000);
    try {
      const customEntry = custom.find((c) => c.symbol === selected);
      const keyHeaders = userKeyHeaders();
      const res = customEntry
        ? await fetch("/api/signal/custom", {
            method: "POST",
            headers: { "content-type": "application/json", ...keyHeaders },
            body: JSON.stringify(customEntry),
            signal: controller.signal,
          })
        : await fetch(`/api/scan?symbol=${selected}`, {
            headers: keyHeaders,
            signal: controller.signal,
          });
      const text = await res.text();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`伺服器回應非 JSON (HTTP ${res.status}): ${text.slice(0, 120)}`);
      }
      if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
      // /api/scan wraps the signal; /api/signal/custom returns it bare.
      const signalData = (data as { signal?: TradeSignal }).signal ?? (data as TradeSignal);
      setSignal(signalData);
      setStale(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timeout);
      setBuilding(false);
    }
  }, [selected, custom]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSignal(null);
    setStale(false);

    void loadStored().then((stored) => {
      if (cancelled) return;
      setLoading(false);
      if (stored) {
        setSignal(stored);
        return;
      }
      // Nothing stored — a custom symbol, or one the scan has never covered.
      // Building it here is the only way to show anything at all.
      setStale(true);
      void rebuild();
    });

    return () => {
      cancelled = true;
    };
  }, [selected, loadStored, rebuild]);

  return (
    <main className="mx-auto min-h-screen max-w-2xl px-4 py-5">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h1 className="text-base font-bold text-neutral-100">多商品交易訊號</h1>
        <nav className="flex shrink-0 gap-3 text-sm text-neutral-500">
          <Link href="/board" className="hover:text-neutral-200">
            總覽
          </Link>
          <Link href="/settings" className="hover:text-neutral-200">
            金鑰
          </Link>
          <Link href="/setup" className="hover:text-neutral-200">
            通知
          </Link>
          <Link href="/symbols" className="hover:text-neutral-200">
            自訂標的
          </Link>
          <Link href="/review" className="hover:text-neutral-200">
            復盤
          </Link>
          <Link href="/history" className="hover:text-neutral-200">
            歷史
          </Link>
        </nav>
      </header>

      <div className="mb-4">
        <CommodityList symbols={symbols} selected={selected} onSelect={setSelected} />
      </div>

      {(loading || (building && !signal)) && (
        <p className="py-8 text-center text-sm text-neutral-500">
          {building ? `分析 ${selected} 中…` : `載入 ${selected}…`}
          {building && (
            <span className="mt-1 block text-xs text-neutral-600">
              這個商品還沒有掃描紀錄，需向多個外部來源取資料，約 10–30 秒
            </span>
          )}
        </p>
      )}
      {error && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
          <p>取得訊號失敗：{error}</p>
          <a href="/api/diagnostics" className="mt-2 block text-xs underline hover:text-red-200">
            檢查各資料來源連線狀態 →
          </a>
        </div>
      )}

      {signal && (
        <>
          <div className="mb-2 flex items-center gap-3 text-[11px] text-neutral-600">
            <span>
              資料時間 {new Date(signal.generated_at).toLocaleString("zh-TW")}
              {!stale && "（與總覽同一筆）"}
            </span>
            <button
              type="button"
              onClick={() => void rebuild()}
              disabled={building}
              className="ml-auto shrink-0 rounded-lg border border-neutral-700 px-2.5 py-1 text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
            >
              {building ? "重新分析中…" : "重新分析"}
            </button>
          </div>
          <SignalCard signal={signal} />
        </>
      )}
    </main>
  );
}

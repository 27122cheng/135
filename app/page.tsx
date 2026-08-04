"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { SupportedSymbol, TradeSignal } from "@/types/signal";
import { CommodityList } from "@/components/commodity-list";
import { SignalCard } from "@/components/signal-card";

export default function Home() {
  const [selected, setSelected] = useState<SupportedSymbol>("XAUUSD");
  const [signal, setSignal] = useState<TradeSignal | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSignal(null);
    // Without this the page can sit on "載入中" forever if the serverless
    // function times out and never sends a usable response.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 70000);
    fetch(`/api/signal/${selected}`, { signal: controller.signal })
      .then(async (res) => {
        const text = await res.text();
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          // A gateway timeout/5xx returns HTML, not JSON — show something useful.
          throw new Error(`伺服器回應非 JSON (HTTP ${res.status}): ${text.slice(0, 120)}`);
        }
        if (!res.ok) {
          const err = (data as { error?: string }).error;
          throw new Error(err ?? `HTTP ${res.status}`);
        }
        return data as TradeSignal;
      })
      .then((data) => {
        if (!cancelled) setSignal(data);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        clearTimeout(timeout);
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [selected]);

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl gap-6 p-6">
      <aside className="w-56 shrink-0">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-lg font-bold text-neutral-100">多商品交易訊號</h1>
        </div>
        <CommodityList selected={selected} onSelect={setSelected} />
        <Link
          href="/history"
          className="mt-4 block rounded-lg px-3 py-2 text-sm text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
        >
          歷史訊號 →
        </Link>
      </aside>

      <section className="flex-1">
        {loading && (
          <p className="text-sm text-neutral-500">
            載入 {selected} 訊號中…（首次查詢需向多個外部來源取資料，可能要 10–30 秒）
          </p>
        )}
        {error && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
            <p>取得訊號失敗：{error}</p>
            <a href="/api/diagnostics" className="mt-2 block underline hover:text-red-200">
              開啟 /api/diagnostics 檢查各資料來源在部署環境的連線狀態 →
            </a>
          </div>
        )}
        {!loading && !error && signal && <SignalCard signal={signal} />}
      </section>
    </main>
  );
}

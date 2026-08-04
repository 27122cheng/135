"use client";

import { useEffect, useState } from "react";
import type { SupportedSymbol, TradeSignal } from "@/types/signal";
import { CommodityList } from "@/components/commodity-list";
import { SignalCard } from "@/components/signal-card";

export default function Home() {
  const [selected, setSelected] = useState<SupportedSymbol>("XAUUSD");
  const [signal, setSignal] = useState<TradeSignal | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (selected !== "XAUUSD") return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch("/api/signal/xauusd")
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        return data as TradeSignal;
      })
      .then((data) => {
        if (!cancelled) setSignal(data);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl gap-6 p-6">
      <aside className="w-56 shrink-0">
        <h1 className="mb-4 text-lg font-bold text-neutral-100">多商品交易訊號</h1>
        <CommodityList selected={selected} onSelect={setSelected} />
      </aside>

      <section className="flex-1">
        {loading && <p className="text-sm text-neutral-500">載入 {selected} 訊號中…</p>}
        {error && (
          <p className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
            取得訊號失敗：{error}
          </p>
        )}
        {!loading && !error && signal && <SignalCard signal={signal} />}
      </section>
    </main>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  loadCustomSymbols,
  saveCustomSymbols,
  validateCustomSymbol,
  type CustomSymbol,
} from "@/lib/custom-symbols";
import { SiteNav } from "@/components/site-nav";

interface Suggestion extends CustomSymbol {
  origin: "catalog" | "yahoo";
  hint: string;
}

function Field({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs text-neutral-400">{label}</span>
      {hint && <span className="ml-2 text-[11px] text-neutral-600">{hint}</span>}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
      />
    </label>
  );
}

export default function SymbolsPage() {
  const [list, setList] = useState<CustomSymbol[]>([]);
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<CustomSymbol | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setList(loadCustomSymbols());
  }, []);

  // Debounced so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 1) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      fetch(`/api/symbol-search?q=${encodeURIComponent(q)}`)
        .then((r) => r.json())
        .then((d) => {
          if (!cancelled) setSuggestions(d.suggestions ?? []);
        })
        .catch(() => {
          if (!cancelled) setSuggestions([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const [syncNote, setSyncNote] = useState<string | null>(null);

  const persist = useCallback((next: CustomSymbol[]) => {
    setList(next);
    saveCustomSymbols(next);
    // 同步到伺服器 — the browser copy alone made these symbols invisible to
    // everything scheduled: the board read built-ins, the hourly sweep and
    // the monitor scanned built-ins, so a freshly added BTCUSD produced one
    // on-demand card and then ceased to exist. Same mechanism as the alert
    // settings; a failed sync is shown, not swallowed.
    void (async () => {
      try {
        const res = await fetch("/api/notify/config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ CUSTOM_SYMBOLS: JSON.stringify(next) }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          setSyncNote(`伺服器同步失敗（排程掃描會看不到這些標的）：${body?.error ?? `HTTP ${res.status}`}`);
        } else {
          setSyncNote("已同步到伺服器 —— 總覽、每小時掃描與監控都會包含這些標的");
        }
      } catch (err) {
        setSyncNote(`伺服器同步失敗：${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }, []);

  function choose(s: Suggestion) {
    setPicked({
      symbol: s.symbol,
      label: s.label,
      yahooSymbol: s.yahooSymbol,
      stooqSymbol: s.stooqSymbol,
      cotContractCode: s.cotContractCode,
      gdeltQuery: s.gdeltQuery,
    });
    setSuggestions([]);
    setQuery("");
    setError(null);
    setShowAdvanced(false);
  }

  function add() {
    if (!picked) return;
    const cleaned: CustomSymbol = {
      ...picked,
      symbol: picked.symbol.trim().toUpperCase(),
      label: picked.label.trim(),
      yahooSymbol: picked.yahooSymbol.trim(),
      stooqSymbol: picked.stooqSymbol.trim(),
      cotContractCode: picked.cotContractCode.trim(),
      gdeltQuery: picked.gdeltQuery.trim(),
    };
    const problem = validateCustomSymbol(cleaned);
    if (problem) return setError(problem);
    if (list.some((s) => s.symbol === cleaned.symbol)) {
      return setError(`代號 ${cleaned.symbol} 已經存在`);
    }
    persist([...list, cleaned]);
    setPicked(null);
    setError(null);
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-5">
      <SiteNav title="自訂分析標的" />

      <p className="mb-4 text-xs leading-relaxed text-neutral-500">
        直接輸入商品名稱（中英文都可以），其餘欄位會自動帶入。設定存在這台裝置的瀏覽器，
        不會上傳，也不需要重新部署。
      </p>

      {/* Search — the only field you normally touch. */}
      <div className="relative mb-4">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="輸入商品名稱，例如：白銀、天然氣、日經、bitcoin、AAPL"
          className="w-full rounded-xl border border-neutral-700 bg-neutral-950 px-4 py-3 text-sm text-neutral-100 placeholder:text-neutral-700"
        />
        {searching && (
          <span className="absolute right-4 top-3.5 text-xs text-neutral-600">搜尋中…</span>
        )}

        {suggestions.length > 0 && (
          <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900 shadow-xl">
            {suggestions.map((s) => (
              <li key={`${s.origin}-${s.yahooSymbol}`}>
                <button
                  type="button"
                  onClick={() => choose(s)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-neutral-800"
                >
                  <span className="min-w-0">
                    <span className="text-sm text-neutral-100">{s.label}</span>
                    <span className="ml-2 font-mono text-xs text-neutral-500">{s.yahooSymbol}</span>
                    <span className="block truncate text-[11px] text-neutral-600">{s.hint}</span>
                  </span>
                  {s.origin === "catalog" && (
                    <span className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-400">
                      已校對
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Confirmation — everything prefilled, editable only if you open it. */}
      {picked && (
        <div className="mb-5 rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-neutral-100">
                {picked.label} <span className="text-neutral-600">{picked.symbol}</span>
              </p>
              <p className="mt-0.5 truncate text-[11px] text-neutral-500">
                Yahoo {picked.yahooSymbol}
                {picked.stooqSymbol && ` · Stooq ${picked.stooqSymbol}`}
                {picked.cotContractCode
                  ? ` · CFTC ${picked.cotContractCode}`
                  : " · 無 CFTC 代碼（籌碼面與未平倉量從缺）"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setPicked(null)}
              className="shrink-0 text-xs text-neutral-500 hover:text-neutral-300"
            >
              取消
            </button>
          </div>

          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
          {syncNote && (
            <p className={`mt-2 text-[11px] ${syncNote.includes("失敗") ? "text-amber-400" : "text-emerald-400"}`}>
              {syncNote}
            </p>
          )}

          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={add}
              className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-white"
            >
              加入
            </button>
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="text-xs text-neutral-500 hover:text-neutral-300"
            >
              {showAdvanced ? "收起" : "手動調整欄位"}
            </button>
          </div>

          {showAdvanced && (
            <div className="mt-3 grid gap-3 border-t border-neutral-800 pt-3 sm:grid-cols-2">
              <Field label="代號" value={picked.symbol} onChange={(v) => setPicked({ ...picked, symbol: v })} />
              <Field label="顯示名稱" value={picked.label} onChange={(v) => setPicked({ ...picked, label: v })} />
              <Field label="Yahoo 代碼" value={picked.yahooSymbol} onChange={(v) => setPicked({ ...picked, yahooSymbol: v })} />
              <Field label="Stooq 代碼" hint="備援" value={picked.stooqSymbol} onChange={(v) => setPicked({ ...picked, stooqSymbol: v })} />
              <Field label="CFTC 合約代碼" hint="籌碼面/未平倉量" value={picked.cotContractCode} onChange={(v) => setPicked({ ...picked, cotContractCode: v })} />
              <Field label="新聞查詢" hint="GDELT" value={picked.gdeltQuery} onChange={(v) => setPicked({ ...picked, gdeltQuery: v })} />
            </div>
          )}
        </div>
      )}

      {!picked && (
        <p className="mb-5 text-[11px] leading-relaxed text-neutral-600">
          標「已校對」的是內建清單，含 CFTC 合約代碼；其餘來自 Yahoo 搜尋，只帶得回代碼與名稱，
          要籌碼面與未平倉量得自行補 CFTC 代碼。代碼錯誤不會產生錯誤數字 —— 訊號會回
          no-trade 並在資料缺口說明原因。
        </p>
      )}

      {list.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium text-neutral-400">已加入（{list.length}）</p>
          <ul className="flex flex-col gap-2">
            {list.map((s) => (
              <li
                key={s.symbol}
                className="flex items-center justify-between gap-3 rounded-xl border border-neutral-800 bg-neutral-900/60 p-3"
              >
                <div className="min-w-0">
                  <p className="text-sm text-neutral-100">
                    {s.label} <span className="text-neutral-600">{s.symbol}</span>
                  </p>
                  <p className="truncate text-[11px] text-neutral-500">
                    Yahoo {s.yahooSymbol}
                    {s.cotContractCode && ` · CFTC ${s.cotContractCode}`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => persist(list.filter((x) => x.symbol !== s.symbol))}
                  className="shrink-0 text-xs text-neutral-500 hover:text-red-400"
                >
                  移除
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}

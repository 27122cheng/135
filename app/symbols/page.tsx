"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  loadCustomSymbols,
  saveCustomSymbols,
  validateCustomSymbol,
  type CustomSymbol,
} from "@/lib/custom-symbols";

const EMPTY: CustomSymbol = {
  symbol: "",
  label: "",
  yahooSymbol: "",
  stooqSymbol: "",
  cotContractCode: "",
  gdeltQuery: "",
};

const EXAMPLES = [
  { label: "白銀", symbol: "XAGUSD", yahoo: "SI=F", stooq: "xagusd", cot: "084691" },
  { label: "銅", symbol: "COPPER", yahoo: "HG=F", stooq: "hg.f", cot: "085692" },
  { label: "日經225", symbol: "JP225", yahoo: "^N225", stooq: "^nkx", cot: "" },
  { label: "天然氣", symbol: "NATGAS", yahoo: "NG=F", stooq: "ng.f", cot: "023651" },
  { label: "比特幣", symbol: "BTCUSD", yahoo: "BTC-USD", stooq: "", cot: "" },
];

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs text-neutral-400">{label}</span>
      {hint && <span className="ml-2 text-[11px] text-neutral-600">{hint}</span>}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-700"
      />
    </label>
  );
}

export default function SymbolsPage() {
  const [list, setList] = useState<CustomSymbol[]>([]);
  const [draft, setDraft] = useState<CustomSymbol>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setList(loadCustomSymbols());
  }, []);

  function persist(next: CustomSymbol[]) {
    setList(next);
    saveCustomSymbols(next);
  }

  function add() {
    const cleaned: CustomSymbol = {
      ...draft,
      symbol: draft.symbol.trim().toUpperCase(),
      label: draft.label.trim(),
      yahooSymbol: draft.yahooSymbol.trim(),
      stooqSymbol: draft.stooqSymbol.trim(),
      cotContractCode: draft.cotContractCode.trim(),
      gdeltQuery: draft.gdeltQuery.trim(),
    };
    const problem = validateCustomSymbol(cleaned);
    if (problem) {
      setError(problem);
      return;
    }
    if (list.some((s) => s.symbol === cleaned.symbol)) {
      setError(`代號 ${cleaned.symbol} 已經存在`);
      return;
    }
    setError(null);
    persist([...list, cleaned]);
    setDraft(EMPTY);
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-5">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h1 className="text-base font-bold text-neutral-100">自訂分析標的</h1>
        <Link href="/" className="shrink-0 text-sm text-neutral-500 hover:text-neutral-200">
          ← 回訊號
        </Link>
      </div>

      <p className="mb-4 text-xs leading-relaxed text-neutral-500">
        加入內建 9 個商品以外的標的。只需要一個 Yahoo Finance 代碼就能跑技術面、資金流的
        DXY/VIX 與新聞面；填了 CFTC 合約代碼才會有籌碼面與未平倉量分析。
        設定存在這台裝置的瀏覽器裡，不會上傳，也不需要重新部署。
      </p>

      <div className="mb-5 space-y-3 rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="代號"
            hint="自訂識別用"
            value={draft.symbol}
            onChange={(v) => setDraft({ ...draft, symbol: v })}
            placeholder="XAGUSD"
          />
          <Field
            label="顯示名稱"
            value={draft.label}
            onChange={(v) => setDraft({ ...draft, label: v })}
            placeholder="白銀"
          />
          <Field
            label="Yahoo 代碼"
            hint="必填"
            value={draft.yahooSymbol}
            onChange={(v) => setDraft({ ...draft, yahooSymbol: v })}
            placeholder="SI=F"
          />
          <Field
            label="Stooq 代碼"
            hint="選填，備援用"
            value={draft.stooqSymbol}
            onChange={(v) => setDraft({ ...draft, stooqSymbol: v })}
            placeholder="xagusd"
          />
          <Field
            label="CFTC 合約代碼"
            hint="選填，籌碼面/未平倉量"
            value={draft.cotContractCode}
            onChange={(v) => setDraft({ ...draft, cotContractCode: v })}
            placeholder="084691"
          />
          <Field
            label="新聞查詢"
            hint="選填，GDELT"
            value={draft.gdeltQuery}
            onChange={(v) => setDraft({ ...draft, gdeltQuery: v })}
            placeholder='"silver price" OR bullion'
          />
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <button
          type="button"
          onClick={add}
          className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-white"
        >
          新增標的
        </button>
      </div>

      <div className="mb-5">
        <p className="mb-2 text-xs font-medium text-neutral-400">常用範例（點擊帶入表單）</p>
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((e) => (
            <button
              key={e.symbol}
              type="button"
              onClick={() =>
                setDraft({
                  symbol: e.symbol,
                  label: e.label,
                  yahooSymbol: e.yahoo,
                  stooqSymbol: e.stooq,
                  cotContractCode: e.cot,
                  gdeltQuery: "",
                })
              }
              className="rounded-full border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:border-neutral-500 hover:text-neutral-100"
            >
              {e.label} <span className="text-neutral-600">{e.yahoo}</span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-neutral-600">
          範例代碼取自公開資料整理，未逐一即時驗證。代碼錯誤時訊號會回報「所有 OHLCV
          來源皆失敗」而不會產生錯誤數字 —— 到 Yahoo Finance 搜尋該商品，網址列的代號就是要填的值。
        </p>
      </div>

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
                    {s.stooqSymbol && ` · Stooq ${s.stooqSymbol}`}
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

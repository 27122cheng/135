"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { loadUserKeys, saveUserKeys, type UserKeys } from "@/lib/user-keys-client";
import type { UserSettableKey } from "@/lib/api-key-names";

interface KeyInfo {
  name: UserSettableKey;
  label: string;
  what: string;
  where: string;
  url: string;
  priority: "high" | "medium" | "low";
}

const KEYS: KeyInfo[] = [
  {
    name: "TWELVE_DATA_API_KEY",
    label: "Twelve Data",
    what: "K 線主要來源。不設也能跑（Yahoo→Stooq 備援），但 Yahoo 常擋雲端機房 IP。",
    where: "註冊後 Dashboard 首頁直接顯示",
    url: "https://twelvedata.com/pricing",
    priority: "high",
  },
  {
    name: "ANTHROPIC_API_KEY",
    label: "Anthropic",
    what: "AI 綜合敘述與交易計畫判斷。不設會改用本地預設規則。需付費。",
    where: "Console → Settings → API Keys → Create Key",
    url: "https://console.anthropic.com",
    priority: "high",
  },
  {
    name: "ANTHROPIC_MODEL",
    label: "Anthropic 模型（選填）",
    what: "留空用 claude-opus-5。填 claude-haiku-4-5 會明顯更快、約 1/5 價格。",
    where: "直接填模型名稱，不是金鑰",
    url: "",
    priority: "medium",
  },
  {
    name: "FINNHUB_API_KEY",
    label: "Finnhub",
    what: "額外新聞來源＋美股指數財報日曆。新聞面已由 GDELT 免費供應，優先度低。",
    where: "註冊後 Dashboard 直接顯示",
    url: "https://finnhub.io/register",
    priority: "low",
  },
  {
    name: "FRED_API_KEY",
    label: "FRED（通常不需要）",
    what: "總經資料。已改用 FRED 免金鑰 CSV 端點，資料完全相同。",
    where: "註冊後 Request API Key，立即取得",
    url: "https://fredaccount.stlouisfed.org/apikey",
    priority: "low",
  },
  {
    name: "EIA_API_KEY",
    label: "EIA（通常不需要）",
    what: "WTI 原油庫存。已改用 FRED 的 WCESTUS1（同一份 EIA 資料）。",
    where: "填 Email，金鑰寄到信箱",
    url: "https://www.eia.gov/opendata/register.php",
    priority: "low",
  },
];

const PRIORITY_STYLE: Record<KeyInfo["priority"], string> = {
  high: "border-emerald-500/40",
  medium: "border-neutral-700",
  low: "border-neutral-800",
};

export default function SettingsPage() {
  const [keys, setKeys] = useState<UserKeys>({});
  const [saved, setSaved] = useState(false);
  const [reveal, setReveal] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setKeys(loadUserKeys());
  }, []);

  function save() {
    saveUserKeys(keys);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-5">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h1 className="text-base font-bold text-neutral-100">API 金鑰設定</h1>
        <Link href="/" className="shrink-0 text-sm text-neutral-500 hover:text-neutral-200">
          ← 回訊號
        </Link>
      </div>

      <div className="mb-5 rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
        <p className="text-xs leading-relaxed text-neutral-400">
          貼上金鑰後立即生效 —— 不用設 Vercel 環境變數、不用重新部署。金鑰只存在
          <span className="text-neutral-200"> 這台裝置的瀏覽器</span>裡，每次查詢時隨請求送到本站
          後端使用一次，<span className="text-neutral-200">不會存在伺服器</span>，也不會送到其他地方。
        </p>
        <p className="mt-2 text-[11px] leading-relaxed text-amber-500/80">
          代價：localStorage 可以被這個網站上的任何腳本讀取。個人自用沒問題；如果這個網址會分享給別人，
          改用 Vercel 環境變數比較安全（兩者可並存，環境變數是沒填時的後備）。
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {KEYS.map((k) => (
          <div key={k.name} className={`rounded-xl border ${PRIORITY_STYLE[k.priority]} bg-neutral-900/40 p-4`}>
            <div className="mb-1 flex items-center gap-2">
              <span className="text-sm font-medium text-neutral-100">{k.label}</span>
              {k.priority === "high" && (
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-400">
                  建議設定
                </span>
              )}
              {keys[k.name] && (
                <span className="rounded-full bg-neutral-700 px-2 py-0.5 text-[10px] text-neutral-300">
                  已設定
                </span>
              )}
            </div>
            <p className="mb-2 text-[11px] leading-relaxed text-neutral-500">{k.what}</p>

            <input
              type={reveal[k.name] ? "text" : "password"}
              value={keys[k.name] ?? ""}
              onChange={(e) => setKeys({ ...keys, [k.name]: e.target.value })}
              placeholder={k.name === "ANTHROPIC_MODEL" ? "claude-haiku-4-5" : "貼上金鑰"}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100 placeholder:font-sans placeholder:text-neutral-700"
            />

            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
              <button
                type="button"
                onClick={() => setReveal({ ...reveal, [k.name]: !reveal[k.name] })}
                className="text-neutral-600 hover:text-neutral-400"
              >
                {reveal[k.name] ? "隱藏" : "顯示"}
              </button>
              {k.url && (
                <a
                  href={k.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="whitespace-nowrap text-neutral-500 underline hover:text-neutral-300"
                >
                  去申請 →
                </a>
              )}
              <span className="text-neutral-700">{k.where}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          className="rounded-lg bg-neutral-100 px-5 py-2 text-sm font-medium text-neutral-900 hover:bg-white"
        >
          儲存
        </button>
        {saved && <span className="text-xs text-emerald-400">已儲存，下次查詢就會生效</span>}
        <button
          type="button"
          onClick={() => {
            setKeys({});
            saveUserKeys({});
          }}
          className="ml-auto text-xs text-neutral-600 hover:text-red-400"
        >
          全部清除
        </button>
      </div>
    </main>
  );
}

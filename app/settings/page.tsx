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
    name: "GEMINI_API_KEY",
    label: "Google Gemini",
    what: "AI 主力。免費 1500 次/日，不用信用卡。負責新聞情緒、綜合敘述、交易計畫判斷。",
    where: "登入 Google 帳號 → Get API key → Create API key",
    url: "https://aistudio.google.com/apikey",
    priority: "high",
  },
  {
    name: "GROQ_API_KEY",
    label: "Groq",
    what: "AI 第一備援（llama-3.3-70b）。免費 30 次/分，速度很快。Gemini 額度用完時自動接手。",
    where: "註冊後 API Keys → Create API Key",
    url: "https://console.groq.com/keys",
    priority: "high",
  },
  {
    name: "OPENROUTER_API_KEY",
    label: "OpenRouter（選填）",
    what: "AI 第二備援，走 :free 模型。前兩個都掛掉才會用到。",
    where: "註冊後 Keys → Create Key",
    url: "https://openrouter.ai/keys",
    priority: "low",
  },
  {
    name: "FINNHUB_API_KEY",
    label: "Finnhub（選填）",
    what: "額外新聞來源＋美股財報日曆。新聞面已由 GDELT 免費供應，優先度低。",
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

/** Collapsed by default — model ids and provider order are rarely touched. */
const ADVANCED_KEYS: KeyInfo[] = [
  {
    name: "GEMINI_MODEL",
    label: "Gemini 模型",
    what: "留空用 gemini-2.5-flash。",
    where: "填模型名稱，不是金鑰",
    url: "",
    priority: "medium",
  },
  {
    name: "GROQ_MODEL",
    label: "Groq 模型",
    what: "留空用 llama-3.3-70b-versatile。",
    where: "填模型名稱，不是金鑰",
    url: "",
    priority: "medium",
  },
  {
    name: "OPENROUTER_MODEL",
    label: "OpenRouter 模型",
    what: "留空用 meta-llama/llama-3.3-70b-instruct:free。免費模型會不定期下架，掛了就換一個。",
    where: "填模型名稱，不是金鑰",
    url: "https://openrouter.ai/models?q=free",
    priority: "medium",
  },
  {
    name: "AI_PROVIDER_ORDER",
    label: "供應商順序",
    what: "留空用 gemini,groq,openrouter,anthropic。用逗號分隔，可只填想用的。",
    where: "例如 groq,gemini",
    url: "",
    priority: "medium",
  },
  {
    name: "ANTHROPIC_API_KEY",
    label: "Anthropic（付費，選填）",
    what: "唯一付費選項，排在最後。前面任一個免費供應商能用就永遠不會走到這裡。",
    where: "Console → Settings → API Keys",
    url: "https://console.anthropic.com",
    priority: "medium",
  },
  {
    name: "ANTHROPIC_MODEL",
    label: "Anthropic 模型",
    what: "留空用 claude-haiku-4-5。",
    where: "填模型名稱，不是金鑰",
    url: "",
    priority: "medium",
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
  /** Which keys the server itself holds — see `syncToServer`. */
  const [serverKeys, setServerKeys] = useState<string[] | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    setKeys(loadUserKeys());
    void refreshServerKeys();
  }, []);

  async function refreshServerKeys() {
    try {
      const res = await fetch("/api/notify/config", { cache: "no-store" });
      const body = (await res.json()) as {
        settings?: Array<{ key: string; configured: boolean }>;
      };
      // `configured` covers both an environment variable and a stored row —
      // either way the scheduled run has it, which is the only question here.
      setServerKeys((body.settings ?? []).filter((s) => s.configured).map((s) => s.key));
    } catch {
      setServerKeys(null);
    }
  }

  /**
   * Saving writes the keys twice: to this browser, and to the deployment.
   *
   * localStorage alone was the whole problem. The scheduled scan runs from
   * GitHub Actions with no browser anywhere near it, so it only ever saw
   * `app_settings` — which stayed empty. That is how Telegram could announce a
   * trade built by the local fallback rules ("未設定任何 AI 金鑰") while the
   * website, holding the same keys in localStorage, was reporting a spent
   * quota. Two different analyses, one name.
   *
   * The browser copy is kept as well, so a request still carries its own keys
   * and a deployment shared with someone else does not silently inherit them
   * mid-session.
   */
  async function save() {
    saveUserKeys(keys);
    setSaved(true);
    setSyncError(null);
    setTimeout(() => setSaved(false), 2000);

    const payload = Object.fromEntries(
      Object.entries(keys).filter(([, v]) => typeof v === "string" && v.trim()),
    );
    if (Object.keys(payload).length === 0) return;
    try {
      const res = await fetch("/api/notify/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setSyncError(body?.error ?? `HTTP ${res.status}`);
        return;
      }
      await refreshServerKeys();
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : String(err));
    }
  }

  // Model-name fields hold an identifier, not a secret, so they render as plain
  // text with the model id as placeholder rather than a masked "貼上金鑰" box.
  const isModelField = (name: UserSettableKey) =>
    name.endsWith("_MODEL") || name === "AI_PROVIDER_ORDER";

  const PLACEHOLDERS: Partial<Record<UserSettableKey, string>> = {
    GEMINI_MODEL: "gemini-2.5-flash",
    GROQ_MODEL: "llama-3.3-70b-versatile",
    OPENROUTER_MODEL: "meta-llama/llama-3.3-70b-instruct:free",
    ANTHROPIC_MODEL: "claude-haiku-4-5",
    AI_PROVIDER_ORDER: "gemini,groq,openrouter",
  };

  function renderField(k: KeyInfo) {
    const model = isModelField(k.name);
    return (
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
          {/* The distinction that mattered: a key this browser has is not a key
              the 4-hourly scheduled scan has. */}
          {serverKeys?.includes(k.name) ? (
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-400">
              排程也有
            </span>
          ) : keys[k.name] ? (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-400">
              只在這台裝置
            </span>
          ) : null}
        </div>
        <p className="mb-2 text-[11px] leading-relaxed text-neutral-500">{k.what}</p>

        <input
          type={model || reveal[k.name] ? "text" : "password"}
          value={keys[k.name] ?? ""}
          onChange={(e) => setKeys({ ...keys, [k.name]: e.target.value })}
          placeholder={PLACEHOLDERS[k.name] ?? "貼上金鑰"}
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100 placeholder:font-sans placeholder:text-neutral-700"
        />

        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          {!model && (
            <button
              type="button"
              onClick={() => setReveal({ ...reveal, [k.name]: !reveal[k.name] })}
              className="text-neutral-600 hover:text-neutral-400"
            >
              {reveal[k.name] ? "隱藏" : "顯示"}
            </button>
          )}
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
    );
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

      <div className="mb-5 rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
        <p className="text-xs leading-relaxed text-neutral-400">
          免費 AI 供應商通常保留「用你送出的內容做訓練」的權利。本站送給 AI 的只有
          <span className="text-neutral-200"> 公開市場資料</span>
          —— 價格、公開新聞標題、CFTC 持倉、計算出來的分數。
          不會送出你的帳戶、部位大小或任何個人資料。
        </p>
      </div>

      <div className="flex flex-col gap-3">{KEYS.map(renderField)}</div>

      <details className="mt-3 rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
        <summary className="cursor-pointer text-sm text-neutral-400 hover:text-neutral-200">
          進階：模型名稱、供應商順序、付費選項
        </summary>
        <p className="mt-2 text-[11px] leading-relaxed text-neutral-600">
          全部留空就好。免費模型偶爾會下架，那時候才需要進來換一個。
        </p>
        <div className="mt-3 flex flex-col gap-3">{ADVANCED_KEYS.map(renderField)}</div>
      </details>

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          className="rounded-lg bg-neutral-100 px-5 py-2 text-sm font-medium text-neutral-900 hover:bg-white"
        >
          儲存
        </button>
        {saved && !syncError && (
          <span className="text-xs text-emerald-400">已儲存到這台裝置與排程，下次掃描就會生效</span>
        )}
        {syncError && (
          <span className="text-xs text-amber-400">
            已存到這台裝置，但寫進排程失敗（{syncError}）—— 排程掃描仍會用本地規則
          </span>
        )}
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

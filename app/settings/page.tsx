"use client";

import { useEffect, useState } from "react";
import { loadUserKeys, saveUserKeys, userKeyHeaders, type UserKeys } from "@/lib/user-keys-client";
import type { UserSettableKey } from "@/lib/api-key-names";
import { SiteNav } from "@/components/site-nav";
import { loadSizingConfig, saveSizingConfig, DEFAULT_SIZING } from "@/lib/sizing-client";

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
    name: "TWELVEDATA_API_KEY",
    label: "Twelve Data（建議填）",
    what:
      "第三個即時報價來源，九個商品全支援。Yahoo 與 Stooq 都停更時（發生過，整整一天半所有商品顯示休市中），" +
      "這是唯一還能給出當下價格的來源；GER40 更是除此之外沒有第三個來源。免費 800 次/日，只在主來源超過 3 小時沒更新時才會用到。",
    where: "註冊後 Dashboard 直接顯示 API Key",
    url: "https://twelvedata.com/pricing",
    priority: "high",
  },
  {
    name: "FMP_API_KEY",
    label: "Financial Modeling Prep（選填）",
    what:
      "第四個報價來源。免費 250 次/日，額度較小，所以只有在上面全部都拿不到當下價格時才會被呼叫 —— " +
      "平常完全不消耗。多一家獨立供應商，就多一層「兩家同時掛掉」才會失去價格的保險。",
    where: "註冊後 Dashboard → API Keys",
    url: "https://site.financialmodelingprep.com/developer/docs",
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

/**
 * 部位計算設定 — the two numbers the sizing panel needs.
 *
 * Stored in this device's localStorage only, like the API keys above but for
 * a stronger reason: an account size is about the person, not a market, and
 * has no business in a database whose tables are mostly public-read. The
 * trade-off is the same as the keys' and stated the same way — it does not
 * follow you to another device.
 */
function SizingSection() {
  const [config, setConfig] = useState(DEFAULT_SIZING);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setConfig(loadSizingConfig());
  }, []);

  const update = (next: typeof config) => {
    setConfig(next);
    saveSizingConfig(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="mb-5 rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
      <div className="mb-1 flex items-baseline gap-2">
        <h2 className="text-sm font-medium text-neutral-200">部位計算</h2>
        {saved && <span className="text-[10px] text-emerald-400">已儲存</span>}
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-neutral-500">
        填了之後，每個進場計畫下方會直接算出該下多少（風險金額 ÷ 停損距離），
        已持有高相關部位時自動建議減半。這兩個數字
        <span className="text-neutral-300">只存在這台裝置</span>，不會上傳到伺服器或資料庫。
      </p>
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-[11px] text-neutral-400">
          帳戶規模（USD 或你的帳戶幣別）
          <input
            type="number"
            min={0}
            value={config.accountSize ?? ""}
            placeholder="例如 10000"
            onChange={(e) => {
              const v = Number(e.target.value);
              update({ ...config, accountSize: Number.isFinite(v) && v > 0 ? v : null });
            }}
            className="w-40 rounded-lg border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 font-mono text-sm text-neutral-100"
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-neutral-400">
          單筆風險 %（預設 1）
          <input
            type="number"
            min={0.1}
            max={10}
            step={0.1}
            value={config.riskPct}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v > 0 && v <= 10) update({ ...config, riskPct: v });
            }}
            className="w-28 rounded-lg border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 font-mono text-sm text-neutral-100"
          />
        </label>
      </div>
    </div>
  );
}

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
      <SiteNav title="API 金鑰設定" />

      <SizingSection />

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

      <AiTestPanel />
    </main>
  );
}

interface AiTestRow {
  name: string;
  tier: string;
  configured: boolean;
  ok: boolean;
  detail: string | null;
}

/**
 * 「AI 供應商一直呼叫失敗」cannot be answered by a summary line. This asks
 * each provider one live question with the same keys a real scan would use,
 * and prints the verbatim failure — a bad key, a spent quota, and a retired
 * model id all read differently here, and each has a different fix.
 */
function AiTestPanel() {
  const [rows, setRows] = useState<AiTestRow[] | null>(null);
  const [scheduled, setScheduled] = useState<AiTestRow[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/ai-test", { method: "POST", headers: userKeyHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setRows(data.results as AiTestRow[]);
      setScheduled((data.scheduled as AiTestRow[]) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRows(null);
      setScheduled(null);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="mt-5 rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-neutral-200">測試 AI 供應商</p>
          <p className="mt-0.5 text-[11px] text-neutral-500">
            用目前的金鑰實際各問一次，直接顯示每一家的原始錯誤 —— 金鑰無效、額度用盡、模型下架，看得出是哪一種。
          </p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={running}
          className="shrink-0 rounded-lg bg-neutral-800 px-4 py-2 text-sm text-neutral-200 hover:bg-neutral-700 disabled:opacity-50"
        >
          {running ? "測試中…" : "立即測試"}
        </button>
      </div>
      {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
      {rows && (
        <>
          <p className="mt-3 text-[11px] font-medium text-neutral-400">
            瀏覽器視角（手動重掃看到的：伺服器＋這台裝置的金鑰）
          </p>
          <AiTestList rows={rows} />
        </>
      )}
      {scheduled && (
        <>
          <p className="mt-3 text-[11px] font-medium text-neutral-400">
            排程視角（每小時自動掃描看到的：只有伺服器端設定）
          </p>
          <AiTestList rows={scheduled} />
          {rows &&
            rows.some((r) => r.configured) &&
            scheduled.every((s) => !s.configured) && (
              <p className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-[11px] leading-relaxed text-amber-300">
                診斷：金鑰只存在這台裝置，伺服器端沒有 —— 排程掃描拿不到。回到上方按一次「儲存」，
                並確認沒有出現紅色的「寫進排程失敗」訊息；成功後每個金鑰旁會出現「排程也有」。
                若按了儲存卻反覆回到這個狀態，代表資料庫收下寫入又丟掉（部署間連到不同資料庫分支）——
                最穩的做法：到 Vercel 專案 Settings → Environment Variables 直接新增
                GEMINI_API_KEY / GROQ_API_KEY（All Environments）後 redeploy，
                完全不經資料庫，排程一定讀得到。
              </p>
            )}
        </>
      )}
    </div>
  );
}

function AiTestList({ rows }: { rows: AiTestRow[] }) {
  return (
    <ul className="mt-1.5 space-y-2">
      {rows.map((r) => (
        <li key={r.name} className="rounded-lg border border-neutral-800 bg-neutral-950/50 p-2.5 text-xs">
          <div className="flex items-center gap-2">
            <span className="font-mono text-neutral-200">{r.name}</span>
            <span className="text-[10px] text-neutral-600">{r.tier === "free" ? "免費" : "付費"}</span>
            <span
              className={
                r.ok
                  ? "ml-auto rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400"
                  : r.configured
                    ? "ml-auto rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-400"
                    : "ml-auto rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-500"
              }
            >
              {r.ok ? "正常" : r.configured ? "失敗" : "未設定"}
            </span>
          </div>
          {r.detail && !r.ok && (
            <p className="mt-1 break-all font-mono text-[10px] leading-relaxed text-neutral-500">
              {r.detail}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

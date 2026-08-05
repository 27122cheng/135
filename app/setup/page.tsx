"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

/**
 * 通知設定 — Telegram configured from the browser, no Vercel dashboard.
 *
 * The constraint that shaped this: alerts fire from GitHub Actions with no
 * browser attached, so the token cannot live in localStorage the way the AI
 * keys do. The usual answer is a Vercel environment variable, which means a
 * redeploy every time anything changes and a trip to a second dashboard to do
 * anything at all.
 *
 * So the token goes to the server and into `app_settings` instead: written
 * here, read by the scheduler, never sent back. An environment variable still
 * wins if one is set — a deployment-level decision shouldn't be silently
 * overridden by a web form.
 */

interface SettingStatus {
  key: string;
  configured: boolean;
  source: "env" | "database" | null;
  value: string | null;
}

interface ChatIdInfo {
  chats?: Array<{ id: number; type: string; name: string }>;
  chatId?: number;
  next?: string;
  error?: string;
}

const GRADES = ["A+", "A", "B", "C"];

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
      <div className="mb-2 flex items-center gap-2">
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium ${
            done ? "bg-emerald-500/20 text-emerald-400" : "bg-neutral-800 text-neutral-400"
          }`}
        >
          {done ? "✓" : n}
        </span>
        <h2 className="text-sm font-medium text-neutral-100">{title}</h2>
      </div>
      <div className="space-y-2 pl-7 text-xs leading-relaxed text-neutral-400">{children}</div>
    </section>
  );
}

function Copyable({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-[11px] text-neutral-200">
        {value}
      </code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="shrink-0 rounded-lg border border-neutral-700 px-3 py-2 text-[11px] text-neutral-300 hover:bg-neutral-800"
      >
        {copied ? "已複製" : "複製"}
      </button>
    </div>
  );
}

interface TableStatus {
  supported: boolean;
  tables?: Record<string, boolean>;
  ready?: boolean;
  reason?: string;
  error?: string;
}

export default function SetupPage() {
  const [settings, setSettings] = useState<SettingStatus[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tables, setTables] = useState<TableStatus | null>(null);
  const [tableResult, setTableResult] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [chatIdInput, setChatIdInput] = useState("");
  const [discord, setDiscord] = useState("");
  const [gemini, setGemini] = useState("");
  const [groq, setGroq] = useState("");
  const [minGrade, setMinGrade] = useState("");
  const [chatId, setChatId] = useState<ChatIdInfo | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [saveResult, setSaveResult] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [generated, setGenerated] = useState("");
  const [appUrl, setAppUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/notify/config");
      const body = await res.json();
      setSettings(body.settings ?? []);
      setLoadError(res.ok ? null : (body.next ?? body.error ?? "讀取設定失敗"));
      const grade = (body.settings ?? []).find((s: SettingStatus) => s.key === "ALERT_MIN_GRADE");
      if (grade?.value) setMinGrade(grade.value);
    } catch {
      setLoadError("讀取設定失敗");
    }
    try {
      const res = await fetch("/api/setup");
      setTables(await res.json());
    } catch {
      setTables(null);
    }
  }, []);

  useEffect(() => {
    setAppUrl(window.location.origin);
    void refresh();
  }, [refresh]);

  async function createTables() {
    setBusy("tables");
    setTableResult(null);
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: secret ? { authorization: `Bearer ${secret}` } : {},
      });
      const body = await res.json();
      if (res.ok && body.ready) setTableResult("資料表已就緒");
      else if (res.status === 409) setTableResult(body.error);
      else if (res.status === 401) setTableResult("401 —— 已設定 CRON_SECRET，請在最下方貼上");
      else setTableResult(body.error ?? `${body.failed ?? "?"} 個語句失敗`);
      await refresh();
    } catch {
      setTableResult("建立失敗");
    } finally {
      setBusy(null);
    }
  }

  const missingTables = Object.entries(tables?.tables ?? {})
    .filter(([, exists]) => !exists)
    .map(([name]) => name);
  const get = (key: string) => settings?.find((s) => s.key === key);
  const tokenSet = get("TELEGRAM_BOT_TOKEN")?.configured === true;
  const chatSet = get("TELEGRAM_CHAT_ID")?.configured === true;
  const telegramReady = tokenSet && chatSet;
  const aiKeySet =
    get("GEMINI_API_KEY")?.configured === true || get("GROQ_API_KEY")?.configured === true;

  async function save(payload: Record<string, string>, label: string) {
    setBusy(label);
    setSaveResult(null);
    try {
      const res = await fetch("/api/notify/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (res.ok) {
        setSaveResult("已儲存");
        setSettings(body.settings ?? settings);
        // Never keep a secret in a form field longer than the request needs it.
        if (payload.TELEGRAM_BOT_TOKEN) setToken("");
        if (payload.DISCORD_WEBHOOK_URL) setDiscord("");
        if (payload.GEMINI_API_KEY) setGemini("");
        if (payload.GROQ_API_KEY) setGroq("");
      } else if (res.status === 401) {
        setSaveResult("401 —— 已設定 CRON_SECRET，請在最下方貼上");
      } else {
        setSaveResult(body.next ?? body.error ?? "儲存失敗");
      }
    } catch {
      setSaveResult("儲存失敗");
    } finally {
      setBusy(null);
    }
  }

  async function findChatId() {
    setBusy("chat");
    try {
      const res = await fetch("/api/notify/chat-id");
      const body = await res.json();
      setChatId(body);
      if (typeof body.chatId === "number") setChatIdInput(String(body.chatId));
    } catch {
      setChatId({ error: "請求失敗" });
    } finally {
      setBusy(null);
    }
  }

  async function sendTest() {
    setBusy("test");
    setTestResult(null);
    try {
      const res = await fetch("/api/notify/test", {
        method: "POST",
        headers: secret ? { authorization: `Bearer ${secret}` } : {},
      });
      const body = await res.json();
      if (res.ok) setTestResult(`已送出：${(body.sent ?? []).join("、") || "無"}`);
      else if (res.status === 401) setTestResult("401 —— 已設定 CRON_SECRET，請在最下方貼上");
      else setTestResult(body.error ?? JSON.stringify(body).slice(0, 200));
    } catch {
      setTestResult("請求失敗");
    } finally {
      setBusy(null);
    }
  }

  const inputClass =
    "w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-100 placeholder:font-sans placeholder:text-neutral-700";

  return (
    <main className="mx-auto max-w-2xl px-4 py-5">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h1 className="text-base font-bold text-neutral-100">通知設定</h1>
        <Link href="/" className="shrink-0 text-sm text-neutral-500 hover:text-neutral-200">
          ← 回訊號
        </Link>
      </div>

      <div className="mb-4 rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
        <p className="text-xs leading-relaxed text-neutral-400">
          貼在這裡的設定會存到<span className="text-neutral-200">你的資料庫</span>，
          排程執行時從那裡讀 —— 不用進 Vercel，也不用重新部署。
          存進去之後 token <span className="text-neutral-200">不會再送回瀏覽器</span>，
          這頁只看得到「有沒有設定」。
        </p>
        <p className="mt-2 text-[11px] leading-relaxed text-neutral-600">
          若同名的 Vercel 環境變數存在，以環境變數為準 —— 部署層級的決定不該被網頁表單蓋掉。
        </p>
        {!secret && (
          <p className="mt-2 text-[11px] leading-relaxed text-amber-500/80">
            還沒設 <code>CRON_SECRET</code> 的話，這個網址任何人打得開就能改這些設定。
            設好之後（見第 5 步）就需要它才能寫入。
          </p>
        )}
        {loadError && <p className="mt-2 text-[11px] text-red-400">{loadError}</p>}
      </div>

      <div className="flex flex-col gap-3">
        <Step n={0} title="資料表" done={tables?.ready === true}>
          {tables?.supported === false ? (
            <p className="text-neutral-500">{tables.reason}</p>
          ) : (
            <>
              <p>
                設定要存在資料庫裡，所以這些表得先存在。
                {missingTables.length > 0 && (
                  <>
                    {" "}
                    目前缺：
                    <code className="text-amber-400">{missingTables.join("、")}</code>
                  </>
                )}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void createTables()}
                  disabled={busy === "tables"}
                  className="rounded-lg border border-neutral-700 px-3 py-1.5 text-[11px] text-neutral-200 hover:bg-neutral-800 disabled:opacity-40"
                >
                  {busy === "tables" ? "建立中…" : "建立資料表"}
                </button>
                {tableResult && <span className="text-neutral-400">{tableResult}</span>}
              </div>
              {/* Every statement is `create ... if not exists`, so pressing this
                  on an existing database adds only what's missing. */}
              <p className="text-neutral-600">
                重複按沒有副作用 —— 每個語句都是 create if not exists，只會補上缺的那幾張。
              </p>
            </>
          )}
        </Step>

        <Step n={1} title="建立 Telegram 機器人並貼上 token" done={tokenSet}>
          <p>
            在 Telegram 搜尋{" "}
            <a
              href="https://t.me/BotFather"
              target="_blank"
              rel="noopener noreferrer"
              className="text-neutral-300 underline"
            >
              @BotFather
            </a>
            ，傳 <code className="text-neutral-300">/newbot</code>，取個名字。
            它會回一串長得像 <code className="text-neutral-500">12345:AAH…</code> 的 token。
          </p>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={tokenSet ? "已設定（重新貼上可覆蓋）" : "貼上 bot token"}
            autoComplete="off"
            spellCheck={false}
            className={inputClass}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!token || busy === "token"}
              onClick={() => void save({ TELEGRAM_BOT_TOKEN: token }, "token")}
              className="rounded-lg border border-neutral-700 px-3 py-1.5 text-[11px] text-neutral-200 hover:bg-neutral-800 disabled:opacity-40"
            >
              {busy === "token" ? "儲存中…" : "儲存 token"}
            </button>
            <span className="text-neutral-600">
              {tokenSet
                ? `已設定（來源：${get("TELEGRAM_BOT_TOKEN")?.source === "env" ? "環境變數" : "資料庫"}）`
                : "尚未設定"}
            </span>
          </div>
          <p className="text-amber-500/80">
            token 等同你的機器人密碼。只貼在這裡，不要貼進聊天室或任何對話。
            不小心外洩就回 @BotFather 傳 <code className="text-neutral-300">/revoke</code> 換一組。
          </p>
        </Step>

        <Step n={2} title="查出 Chat ID" done={chatSet}>
          <p>
            先在 Telegram 打開你的機器人，按「開始」或隨便傳一句話 ——
            沒收過訊息的機器人查不到 chat id。然後按下面這顆。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void findChatId()}
              disabled={!tokenSet || busy === "chat"}
              className="rounded-lg border border-neutral-700 px-3 py-1.5 text-[11px] text-neutral-200 hover:bg-neutral-800 disabled:opacity-40"
            >
              {busy === "chat" ? "查詢中…" : "查出我的 Chat ID"}
            </button>
            {!tokenSet && <span className="text-neutral-600">要先存好 token</span>}
          </div>
          {chatId?.error && <p className="text-red-400">{chatId.error}</p>}
          {chatId && chatId.chats?.length === 0 && <p className="text-neutral-500">{chatId.next}</p>}
          <input
            type="text"
            value={chatIdInput}
            onChange={(e) => setChatIdInput(e.target.value)}
            placeholder={chatSet ? `已設定 ${get("TELEGRAM_CHAT_ID")?.value ?? ""}` : "Chat ID"}
            autoComplete="off"
            spellCheck={false}
            className={inputClass}
          />
          <button
            type="button"
            disabled={!chatIdInput || busy === "chatid"}
            onClick={() => void save({ TELEGRAM_CHAT_ID: chatIdInput }, "chatid")}
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-[11px] text-neutral-200 hover:bg-neutral-800 disabled:opacity-40"
          >
            {busy === "chatid" ? "儲存中…" : "儲存 Chat ID"}
          </button>
        </Step>

        <Step n={3} title="測試" done={telegramReady}>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void sendTest()}
              disabled={busy === "test"}
              className="rounded-lg bg-neutral-100 px-3 py-1.5 text-[11px] font-medium text-neutral-900 hover:bg-white disabled:opacity-40"
            >
              {busy === "test" ? "發送中…" : "發送測試訊息"}
            </button>
            {testResult && <span className="text-neutral-400">{testResult}</span>}
          </div>
        </Step>

        <Step n={4} title="警報門檻與 Discord（選填）">
          <p>只有評等達到門檻、且建議進場時才會發送。預設 A。</p>
          <div className="flex flex-wrap gap-1.5">
            {GRADES.map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => {
                  setMinGrade(g);
                  void save({ ALERT_MIN_GRADE: g }, "grade");
                }}
                className={`rounded-lg border px-3 py-1.5 text-[11px] ${
                  minGrade === g
                    ? "border-neutral-500 bg-neutral-800 text-neutral-100"
                    : "border-neutral-800 text-neutral-400 hover:bg-neutral-900"
                }`}
              >
                {g}
              </button>
            ))}
          </div>
          <input
            type="password"
            value={discord}
            onChange={(e) => setDiscord(e.target.value)}
            placeholder={
              get("DISCORD_WEBHOOK_URL")?.configured ? "已設定（重新貼上可覆蓋）" : "Discord webhook URL（選填）"
            }
            autoComplete="off"
            spellCheck={false}
            className={inputClass}
          />
          <button
            type="button"
            disabled={!discord || busy === "discord"}
            onClick={() => void save({ DISCORD_WEBHOOK_URL: discord }, "discord")}
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-[11px] text-neutral-200 hover:bg-neutral-800 disabled:opacity-40"
          >
            {busy === "discord" ? "儲存中…" : "儲存 Discord webhook"}
          </button>
        </Step>

        <Step n={5} title="排程用的 AI 金鑰" done={aiKeySet}>
          <p>
            <code className="text-neutral-300">/settings</code> 的金鑰只存在這台瀏覽器裡，
            <span className="text-neutral-200">排程讀不到</span> ——
            所以四小時掃描一直是用本地規則產生訊號，跟你手動看到的不是同一份分析。
            要讓排程也有 AI，金鑰得存在伺服器這邊。
          </p>
          <input
            type="password"
            value={gemini}
            onChange={(e) => setGemini(e.target.value)}
            placeholder={
              get("GEMINI_API_KEY")?.configured ? "GEMINI_API_KEY 已設定（可覆蓋）" : "GEMINI_API_KEY"
            }
            autoComplete="off"
            spellCheck={false}
            className={inputClass}
          />
          <input
            type="password"
            value={groq}
            onChange={(e) => setGroq(e.target.value)}
            placeholder={
              get("GROQ_API_KEY")?.configured ? "GROQ_API_KEY 已設定（可覆蓋）" : "GROQ_API_KEY（備援）"
            }
            autoComplete="off"
            spellCheck={false}
            className={inputClass}
          />
          <button
            type="button"
            disabled={(!gemini && !groq) || busy === "ai"}
            onClick={() => {
              const payload: Record<string, string> = {};
              if (gemini) payload.GEMINI_API_KEY = gemini;
              if (groq) payload.GROQ_API_KEY = groq;
              void save(payload, "ai");
            }}
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-[11px] text-neutral-200 hover:bg-neutral-800 disabled:opacity-40"
          >
            {busy === "ai" ? "儲存中…" : "儲存 AI 金鑰"}
          </button>
          <p className="text-neutral-600">
            瀏覽器裡的金鑰仍然優先 —— 存在這裡的只在沒有前者時（也就是排程）才會用到。
          </p>
        </Step>

        <Step n={6} title="打開排程（選填）">
          <p>
            掃描與監控已經在 GitHub Actions 上跑了，
            <span className="text-neutral-200">不需要再設定任何東西</span> ——
            網址寫在 workflow 裡當預設值。下面這個只是加鎖，不加也會運作。
          </p>
          <p className="text-neutral-600">
            要覆寫網址的話，設一個名為 <code className="text-neutral-400">APP_URL</code> 的
            repository secret：<span className="font-mono">{appUrl}</span>
          </p>
          <div className="space-y-1.5">
            <p className="text-neutral-500">
              <code className="text-neutral-300">CRON_SECRET</code> —— 隨機字串，擋掉外人觸發你的排程、
              也擋掉外人改這頁的設定。
              <span className="text-neutral-600">
                {" "}
                同一個值要填兩個地方：GitHub repository secret 與 Vercel 環境變數。
              </span>
            </p>
            {generated ? (
              <Copyable value={generated} />
            ) : (
              <button
                type="button"
                onClick={() => setGenerated(crypto.randomUUID().replace(/-/g, ""))}
                className="rounded-lg border border-neutral-700 px-3 py-1.5 text-[11px] text-neutral-200 hover:bg-neutral-800"
              >
                產生一組
              </button>
            )}
          </div>
          <p className="text-neutral-600">
            可以到 GitHub 的 Actions 分頁手動按 Run workflow 立刻驗證，不用等四小時。
          </p>
          <p className="text-amber-500/80">
            實測：4 小時掃描準時，但「5 分鐘監控」GitHub 實際上只給到大約每 1～2 小時一次
            —— 它會把高頻排程降級。真的需要 5 分鐘的話，去{" "}
            <a
              href="https://cron-job.org"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              cron-job.org
            </a>{" "}
            （免費、免信用卡）建一個排程打{" "}
            <span className="font-mono">{appUrl}/api/monitor</span>，兩邊同時打沒有副作用。
          </p>
        </Step>
      </div>

      {saveResult && (
        <p className="mt-3 text-xs text-neutral-400">{saveResult}</p>
      )}

      <div className="mt-4 rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
        <p className="mb-2 text-[11px] text-neutral-500">
          已經設過 <code className="text-neutral-400">CRON_SECRET</code> 的話，
          寫入設定與發送測試都需要它。貼在這裡只用於本次操作，不會存起來。
        </p>
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="CRON_SECRET（若已設定）"
          autoComplete="off"
          spellCheck={false}
          className={inputClass}
        />
      </div>

      <p className="mt-4 text-[11px] leading-relaxed text-neutral-600">
        AI 金鑰在{" "}
        <Link href="/settings" className="underline hover:text-neutral-400">
          金鑰設定
        </Link>
        ，那些存在瀏覽器裡、跟著每次請求走一趟，不經過伺服器儲存。
        這頁的設定相反：排程要用，所以存在伺服器。
      </p>
    </main>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

/**
 * 部署設定 — the steps that cannot live in localStorage.
 *
 * `/settings` covers the AI keys, which the browser can carry per request. The
 * things on this page can't work that way: the 4-hour refresh and the 5-minute
 * monitor run from GitHub Actions with no browser attached, so a Telegram token
 * or a database URL sitting in localStorage would be unreadable at exactly the
 * moment it is needed. They have to be server-side environment variables.
 *
 * That makes the setup a multi-tab errand across BotFather, Vercel and GitHub,
 * and the step that reliably stalls it is the Telegram chat id — a number the
 * app can look up but nobody can guess. So this page does the lookups and the
 * verification, and states plainly which parts are the operator's to click.
 */

interface ChannelStatus {
  name: string;
  configured: boolean;
}

interface NotifyInfo {
  channels: ChannelStatus[];
  minGrade: string;
}

interface ChatIdInfo {
  chats?: Array<{ id: number; type: string; name: string }>;
  chatId?: number;
  next?: string;
  error?: string;
}

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

function Copyable({ value, label }: { value: string; label?: string }) {
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
        {copied ? "已複製" : (label ?? "複製")}
      </button>
    </div>
  );
}

export default function SetupPage() {
  const [notify, setNotify] = useState<NotifyInfo | null>(null);
  const [chatId, setChatId] = useState<ChatIdInfo | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [generated, setGenerated] = useState("");
  const [appUrl, setAppUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/notify/test");
      setNotify(await res.json());
    } catch {
      setNotify(null);
    }
  }, []);

  useEffect(() => {
    setAppUrl(window.location.origin);
    void refresh();
  }, [refresh]);

  const telegram = notify?.channels.find((c) => c.name === "telegram");
  const discord = notify?.channels.find((c) => c.name === "discord");
  const anyChannel = Boolean(telegram?.configured || discord?.configured);

  async function findChatId() {
    setBusy("chat");
    try {
      const res = await fetch("/api/notify/chat-id");
      setChatId(await res.json());
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
        // Only sent when the operator pastes it; the route is open until
        // CRON_SECRET exists, after which it needs the bearer.
        headers: secret ? { authorization: `Bearer ${secret}` } : {},
      });
      const body = await res.json();
      if (res.ok) setTestResult(`已送出：${(body.sent ?? []).join("、") || "無"}`);
      else if (res.status === 401) setTestResult("401 —— 已設定 CRON_SECRET，請在下方貼上才能測試");
      else setTestResult(body.error ?? JSON.stringify(body).slice(0, 200));
    } catch {
      setTestResult("請求失敗");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-5">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h1 className="text-base font-bold text-neutral-100">部署設定</h1>
        <Link href="/" className="shrink-0 text-sm text-neutral-500 hover:text-neutral-200">
          ← 回訊號
        </Link>
      </div>

      <div className="mb-4 rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
        <p className="text-xs leading-relaxed text-neutral-400">
          這頁的設定<span className="text-neutral-200">不能</span>存在瀏覽器裡。掃描與通知是由 GitHub
          Actions 排程觸發的，那時候沒有任何瀏覽器開著 —— 存在 localStorage
          的東西在真正需要它的那一刻讀不到。所以這些必須是<span className="text-neutral-200">
            伺服器環境變數
          </span>
          。
        </p>
        <p className="mt-2 text-[11px] leading-relaxed text-neutral-600">
          填環境變數與 GitHub Secret 的動作只能你自己來（我沒有你帳號的權限）。
          這頁負責把要填的值算好、把設定結果驗給你看。
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <Step n={1} title="建立 Telegram 機器人" done={telegram?.configured}>
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
            它會回你一串 token（長得像 <code className="text-neutral-500">12345:AAH...</code>）。
          </p>
          <p className="text-neutral-500">
            把那串 token 貼到 Vercel → 你的專案 → Settings → Environment Variables，
            變數名稱 <code className="text-neutral-300">TELEGRAM_BOT_TOKEN</code>，然後 Redeploy。
          </p>
          <p className="text-amber-500/80">
            token 直接貼進 Vercel，不要貼給我、也不要貼在這個頁面上。
          </p>
          <p>
            目前狀態：
            {telegram?.configured ? (
              <span className="text-emerald-400"> 已偵測到 TELEGRAM_BOT_TOKEN</span>
            ) : (
              <span className="text-neutral-500"> 尚未設定</span>
            )}
            <button
              type="button"
              onClick={() => void refresh()}
              className="ml-2 text-neutral-600 underline hover:text-neutral-400"
            >
              重新檢查
            </button>
          </p>
        </Step>

        <Step n={2} title="找出你的 Chat ID">
          <p>
            先在 Telegram 打開你剛建立的機器人，按「開始」或隨便傳一句話 ——
            沒有收過訊息的機器人查不到 chat id。然後按下面這顆按鈕。
          </p>
          <button
            type="button"
            onClick={() => void findChatId()}
            disabled={busy === "chat"}
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-[11px] text-neutral-200 hover:bg-neutral-800 disabled:opacity-40"
          >
            {busy === "chat" ? "查詢中…" : "查出我的 Chat ID"}
          </button>
          {chatId?.error && <p className="text-red-400">{chatId.error}</p>}
          {chatId?.chatId !== undefined && (
            <div className="space-y-1.5">
              <Copyable value={String(chatId.chatId)} />
              <p className="text-neutral-500">
                填進 Vercel 環境變數 <code className="text-neutral-300">TELEGRAM_CHAT_ID</code>，
                然後 Redeploy。
              </p>
            </div>
          )}
          {chatId && chatId.chats?.length === 0 && <p className="text-neutral-500">{chatId.next}</p>}
        </Step>

        <Step n={3} title="測試通知" done={anyChannel}>
          <p>
            兩個變數都設好、Redeploy 完成之後，按這裡送一則測試訊息到你的 Telegram。
          </p>
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
          <p className="text-neutral-600">
            通道狀態：Telegram {telegram?.configured ? "✓" : "—"}　Discord{" "}
            {discord?.configured ? "✓" : "—"}
            {notify && `　警報門檻 ${notify.minGrade} 級以上`}
          </p>
        </Step>

        <Step n={4} title="打開排程（沒有這步，網站不會自己跑）">
          <p>
            掃描與監控是 GitHub Actions 在跑，需要兩個 repository secret 才會動。
            到 GitHub repo → Settings → Secrets and variables → Actions → New repository secret。
          </p>
          <div className="space-y-1.5">
            <p className="text-neutral-500">
              <code className="text-neutral-300">APP_URL</code>
            </p>
            <Copyable value={appUrl} />
          </div>
          <div className="space-y-1.5">
            <p className="text-neutral-500">
              <code className="text-neutral-300">CRON_SECRET</code> —— 隨機字串，用來擋掉外人觸發你的排程。
              <span className="text-neutral-600">
                {" "}
                同一個值要同時填進 GitHub Secret 和 Vercel 環境變數。
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
            設好之後可以到 GitHub 的 Actions 分頁，手動按 Run workflow 立刻驗證，
            不用等四小時。
          </p>
        </Step>
      </div>

      <div className="mt-4 rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
        <p className="mb-2 text-[11px] text-neutral-500">
          已經設過 <code className="text-neutral-400">CRON_SECRET</code> 的話，測試通知需要它才能通過驗證。
          貼在這裡只用於這次測試，不會存起來。
        </p>
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="CRON_SECRET（選填）"
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-100 placeholder:font-sans placeholder:text-neutral-700"
        />
      </div>

      <p className="mt-4 text-[11px] leading-relaxed text-neutral-600">
        資料庫（<code>DATABASE_URL</code>）另外在{" "}
        <Link href="/review" className="underline hover:text-neutral-400">
          復盤頁
        </Link>{" "}
        設定與建表。AI 金鑰在{" "}
        <Link href="/settings" className="underline hover:text-neutral-400">
          金鑰設定
        </Link>
        ，那些可以存在瀏覽器裡，不用碰 Vercel。
      </p>
    </main>
  );
}

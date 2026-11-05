"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { SiteNav } from "@/components/site-nav";

/**
 * 資料來源 — is each upstream answering, who is serving each family right
 * now, and which three free sources come first. Probed from the deployment
 * itself (the only vantage that can tell "no key" from "blocked IP").
 */

interface Rung {
  id: string;
  label: string;
  free: boolean;
  keyName: string | null;
  hasKey: boolean;
  note: string | null;
  status: "ok" | "fail" | "no-key" | "unprobed";
  httpStatus: number | null;
  ms: number | null;
  detail: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  failures: number;
  blockedForMs: number;
}

interface Family {
  id: string;
  label: string;
  answers: string;
  freeFirst: string[];
  serving: string | null;
  rungs: Rung[];
}

interface Diagnostics {
  checkedAt: string;
  families?: Family[];
  verdict?: string[];
  error?: string;
}

const DOT: Record<Rung["status"], string> = {
  ok: "bg-emerald-400",
  fail: "bg-red-400",
  "no-key": "bg-neutral-600",
  unprobed: "bg-sky-400/70",
};
const STATUS_TEXT: Record<Rung["status"], string> = {
  ok: "正常",
  fail: "失敗",
  "no-key": "未設金鑰",
  unprobed: "由掃描時使用",
};

function ago(iso: string | null): string {
  if (!iso) return "尚未";
  const m = (Date.now() - Date.parse(iso)) / 60_000;
  if (!Number.isFinite(m)) return "—";
  return m < 1 ? "剛剛" : m < 60 ? `${Math.round(m)} 分鐘前` : m < 1440 ? `${Math.round(m / 60)} 小時前` : `${Math.round(m / 1440)} 天前`;
}

export default function SourcesPage() {
  const [data, setData] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/diagnostics", { cache: "no-store" });
      setData((await res.json()) as Diagnostics);
    } catch (err) {
      setData({ checkedAt: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const families = data?.families ?? [];
  const broken = families.filter((f) => f.serving === null);

  return (
    <main className="mx-auto max-w-2xl px-4 py-5">
      <SiteNav title="資料來源" />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-neutral-500">
        <span>
          每個家族由上而下試，沒資料就換下一個；<span className="text-emerald-300">免費首選</span> 排在最前面。
          {data?.checkedAt ? ` 檢查於 ${new Date(data.checkedAt).toLocaleTimeString()}。` : ""}
        </span>
        <button type="button" onClick={() => void load()} disabled={loading} className="rounded-lg border border-neutral-700 px-2.5 py-1 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-40">
          {loading ? "檢查中…" : "↻ 重新檢查"}
        </button>
      </div>

      {data?.error && <p className="mb-3 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">{data.error}</p>}

      {!loading && families.length > 0 && (
        <div className={`mb-3 rounded-xl border p-3 text-sm ${broken.length === 0 ? "border-emerald-500/40 bg-emerald-500/[0.07] text-emerald-300" : "border-red-500/40 bg-red-500/[0.07] text-red-300"}`}>
          {broken.length === 0
            ? `全部 ${families.length} 個資料家族都有來源在供應。`
            : `${broken.length} 個家族目前沒有任何來源回應：${broken.map((f) => f.label).join("、")} —— 該家族的因子會以「資料缺口」呈現，不會用假數字補。`}
        </div>
      )}

      {loading && <p className="py-8 text-center text-sm text-neutral-500">逐一探測中（約 10 秒）…</p>}

      <div className="flex flex-col gap-3">
        {families.map((f) => {
          const serving = f.rungs.find((r) => r.id === f.serving) ?? null;
          return (
            <section key={f.id} className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-3">
              <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <h2 className="text-sm font-medium text-neutral-200">{f.label}</h2>
                <span className={`text-[11px] ${serving ? "text-emerald-300" : "text-red-300"}`}>
                  {serving ? `供應中：${serving.label}` : "無來源回應"}
                </span>
              </div>
              <p className="mb-2 text-[11px] text-neutral-500">回答：{f.answers}</p>
              <ol className="flex flex-col gap-1">
                {f.rungs.map((r, i) => {
                  const firstFree = f.freeFirst.includes(r.id);
                  return (
                    <li key={r.id} className="grid grid-cols-[1rem_1fr] items-start gap-x-2 text-[11px]">
                      <span className={`mt-1 h-2 w-2 rounded-full ${DOT[r.status]}`} aria-label={STATUS_TEXT[r.status]} />
                      <div className="min-w-0">
                        <span className="text-neutral-300">
                          {i + 1}. {r.label}
                        </span>
                        {firstFree && <span className="ml-1.5 rounded bg-emerald-500/15 px-1 text-[10px] text-emerald-300">免費首選</span>}
                        {!r.free && <span className="ml-1.5 rounded bg-neutral-700 px-1 text-[10px] text-neutral-300">付費</span>}
                        <span className="ml-1.5 text-neutral-500">
                          {STATUS_TEXT[r.status]}
                          {r.ms !== null ? `・${r.ms} ms` : ""}
                          {r.httpStatus !== null && r.status === "fail" ? `・HTTP ${r.httpStatus}` : ""}
                          {r.lastSuccessAt ? `・最近成功 ${ago(r.lastSuccessAt)}` : ""}
                          {r.blockedForMs > 0 ? `・退避中 ${Math.round(r.blockedForMs / 1000)}s` : ""}
                        </span>
                        {r.status === "no-key" && r.keyName && (
                          <span className="ml-1.5 text-neutral-500">
                            → <Link href="/settings" className="underline hover:text-neutral-300">設定 {r.keyName}</Link>
                          </span>
                        )}
                        {r.note && <span className="block text-[10px] text-neutral-600">{r.note}</span>}
                        {r.status === "fail" && r.detail && <span className="block truncate text-[10px] text-red-400/70">{r.detail}</span>}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          );
        })}
      </div>
      <p className="mt-4 text-[11px] leading-relaxed text-neutral-600">
        探測是從部署環境發出的輕量 GET，不消耗各來源的配額。「由掃描時使用」代表此來源沒有不帶金鑰的探測網址，
        實際是否成功看「最近成功」時間（由掃描寫入）。任何來源拿不到資料都不會用假數字補 —— 對應因子標為資料缺口，信心度扣分。
      </p>
    </main>
  );
}

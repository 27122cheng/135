"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { PositionRow } from "@/app/api/positions/route";
import type { UsdExposure } from "@/lib/board-row";
import { SiteNav } from "@/components/site-nav";

/**
 * 持倉 — the page the monitor deserved from the start.
 *
 * Everything on it already existed in `plan_monitor`: which plans are open,
 * where their stops have been moved to, how many add-ons filled. None of it
 * was visible anywhere except a Telegram push you had to scroll back to find,
 * so a trade could be open for two days at breakeven while the site showed
 * the same card as an instrument nobody had touched.
 */

interface Candidate {
  symbol: string;
  direction: "long" | "short";
  grade: string;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskReward: number | null;
}

interface PositionsResponse {
  open?: PositionRow[];
  resolved?: PositionRow[];
  cluster?: UsdExposure | null;
  candidates?: Candidate[];
  error?: string;
  next?: string;
}

function fmt(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return Math.abs(n) < 10 ? n.toFixed(5) : n.toFixed(2);
}

const STATE_LABEL: Record<string, string> = {
  entered: "已進場",
  added: "已加倉",
  waiting: "等待進場",
  stop_hit: "已停損",
  target_hit: "已停利",
  invalidated: "已失效",
};

function PositionCard({ row }: { row: PositionRow }) {
  const long = row.direction === "long";
  const rTone =
    row.openR === null
      ? "text-neutral-500"
      : row.openR > 0
        ? "text-emerald-400"
        : row.openR < 0
          ? "text-red-400"
          : "text-neutral-400";

  return (
    <div
      className={`rounded-xl border p-3 ${
        row.paper ? "border-neutral-800 bg-neutral-950/40" : "border-emerald-500/30 bg-emerald-500/[0.03]"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-neutral-100">{row.label}</span>
        <span className={`text-xs font-medium ${long ? "text-emerald-400" : "text-red-400"}`}>
          {long ? "做多 ▲" : "做空 ▼"}
        </span>
        {row.grade && (
          <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-300">
            {row.grade}
          </span>
        )}
        <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
          {STATE_LABEL[row.state] ?? row.state}
        </span>
        {row.paper && (
          <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-500">
            紙上追蹤
          </span>
        )}
        {row.openR !== null && (
          <span className={`ml-auto shrink-0 font-mono text-sm ${rTone}`}>
            {row.openR > 0 ? "+" : ""}
            {row.openR}R
          </span>
        )}
      </div>

      <dl className="mt-2.5 grid grid-cols-4 gap-2">
        <div>
          <dt className="text-[10px] text-neutral-600">進場</dt>
          <dd className="font-mono text-xs text-neutral-200">{fmt(row.entry)}</dd>
        </div>
        <div>
          <dt className="text-[10px] text-neutral-600">現價</dt>
          <dd className="font-mono text-xs text-neutral-200">{fmt(row.lastPrice)}</dd>
        </div>
        <div>
          <dt className="text-[10px] text-neutral-600">
            停損{row.stopMoved && <span className="ml-1 text-emerald-500">已移動</span>}
          </dt>
          <dd className="font-mono text-xs text-red-400">
            {fmt(row.activeStop)}
            {row.stopMoved && (
              <span className="ml-1 text-[10px] text-neutral-600 line-through">
                {fmt(row.stopLoss)}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] text-neutral-600">停利</dt>
          <dd className="font-mono text-xs text-emerald-400">{fmt(row.takeProfit)}</dd>
        </div>
      </dl>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-neutral-600">
        {row.addOnsFilled > 0 && <span>已加倉 {row.addOnsFilled} 段</span>}
        {row.openedAt && <span>計畫時間 {new Date(row.openedAt).toLocaleString("zh-TW")}</span>}
        <Link href={`/?symbol=${row.symbol}`} className="ml-auto underline hover:text-neutral-400">
          完整分析 →
        </Link>
      </div>
    </div>
  );
}

export default function PositionsPage() {
  const [data, setData] = useState<PositionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/positions", { cache: "no-store" });
      const body: PositionsResponse = await res.json();
      setData(body);
      setError(res.ok ? null : (body.next ?? body.error ?? "讀取失敗"));
    } catch {
      setError("讀取失敗");
    }
  }, []);

  useEffect(() => {
    void load();
    // The monitor writes every five minutes; matching it keeps the page
    // honest without polling for the sake of it.
    const timer = setInterval(() => void load(), 5 * 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const open = data?.open ?? [];
  const real = open.filter((r) => !r.paper);
  const paper = open.filter((r) => r.paper);
  const candidates = data?.candidates ?? [];

  return (
    <main className="mx-auto max-w-2xl px-4 py-5">
      <SiteNav title="持倉" />

      {error && (
        <div className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-400">
          {error}
        </div>
      )}

      {data?.cluster && (
        <div className="mb-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-300">
          <p className="font-medium">
            ⚠ 合併風險敞口：{data.cluster.symbols.join("、")} 實質上都是
            {data.cluster.side === "long" ? "做多" : "做空"}美元
          </p>
          <p className="mt-1 leading-relaxed text-amber-400/80">
            這 {data.cluster.symbols.length} 筆應合併當一筆計算風險，而不是各自獨立配置 ——
            同時進場等於同一個宏觀方向開 {data.cluster.symbols.length} 倍槓桿。
          </p>
        </div>
      )}

      <section className="mb-4">
        <h2 className="mb-2 text-sm font-medium text-neutral-300">
          追蹤中的交易 {real.length > 0 && <span className="text-neutral-600">（{real.length}）</span>}
        </h2>
        {real.length === 0 ? (
          <p className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 text-xs leading-relaxed text-neutral-500">
            目前沒有追蹤中的部位。訊號達到門檻並觸及進場價之後，5 分鐘監控會自動開始追蹤，
            停損移動與結算都會出現在這裡。
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {real.map((r) => (
              <PositionCard key={r.symbol} row={r} />
            ))}
          </div>
        )}
      </section>

      {candidates.length > 0 && (
        <section className="mb-4">
          <h2 className="mb-2 text-sm font-medium text-neutral-300">
            今日可進場的建議 <span className="text-neutral-600">（{candidates.length}）</span>
          </h2>
          <div className="flex flex-col gap-1.5">
            {candidates.map((c) => (
              <Link
                key={c.symbol}
                href={`/?symbol=${c.symbol}`}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-800 px-3 py-2 text-xs hover:bg-neutral-900/60"
              >
                <span className="w-20 shrink-0 font-medium text-neutral-200">{c.symbol}</span>
                <span className={c.direction === "long" ? "text-emerald-400" : "text-red-400"}>
                  {c.direction === "long" ? "做多 ▲" : "做空 ▼"}
                </span>
                <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-300">
                  {c.grade}
                </span>
                <span className="font-mono text-neutral-400">
                  {fmt(c.entry)} → {fmt(c.takeProfit)}
                </span>
                {c.riskReward !== null && (
                  <span className="ml-auto shrink-0 text-neutral-500">1:{c.riskReward}</span>
                )}
              </Link>
            ))}
          </div>
        </section>
      )}

      {paper.length > 0 && (
        <section className="mb-4">
          <h2 className="mb-2 text-sm font-medium text-neutral-400">
            參考價位紙上追蹤 <span className="text-neutral-600">（{paper.length}）</span>
          </h2>
          <p className="mb-2 text-[11px] leading-relaxed text-neutral-600">
            未達交易門檻、系統沒有建議進場的價位，仍然追蹤到底以便驗證門檻本身 ——
            假設完美成交、無滑價，成績讀作上限。
          </p>
          <div className="flex flex-col gap-2">
            {paper.map((r) => (
              <PositionCard key={`${r.symbol}-paper`} row={r} />
            ))}
          </div>
        </section>
      )}

      <p className="text-[11px] leading-relaxed text-neutral-600">
        這頁讀的是 5 分鐘監控自己的紀錄，不重新抓價 —— 顯示的「現價」是監控最後一次觀察到的價格。
        停損移動規則：獲利達 1R 移到成本，2R 之後跟隨結構。結算後自動寫入
        <Link href="/review" className="underline hover:text-neutral-400">
          交易總結
        </Link>
        。
      </p>
    </main>
  );
}

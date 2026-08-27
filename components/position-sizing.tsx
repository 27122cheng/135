"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { positionSize } from "@/lib/analysis/sizing";
import { loadSizingConfig } from "@/lib/sizing-client";
import type { CorrelationReport } from "@/lib/analysis/correlation";

/**
 * 這筆該下多少 — rendered directly under the plan it sizes.
 *
 * A client component on purpose: the account size lives in this device's
 * localStorage and must not travel to the server (see lib/sizing-client.ts),
 * so the arithmetic happens where the number already is.
 *
 * The correlation halving needs two live facts — what is currently held, and
 * what correlates with this symbol — both fetched once on mount from APIs the
 * site already serves. Either fetch failing degrades to sizing without the
 * halving, with no error shown: a missing refinement must not take down the
 * base number.
 */

interface HeldPosition {
  symbol: string;
  /** plan_monitor state — entered/added means genuinely held. */
  state: string;
  paper?: boolean;
}

export function PositionSizing({
  symbol,
  direction,
  entry,
  stopLoss,
}: {
  symbol: string;
  direction: "long" | "short";
  entry: number;
  stopLoss: number;
}) {
  const [config, setConfig] = useState(() => loadSizingConfig());
  const [correlatedHeld, setCorrelatedHeld] = useState<string[]>([]);
  /** 歷史最長連敗 — from the system's own settled trades, for the survival line. */
  const [lossStreak, setLossStreak] = useState<number | null>(null);

  useEffect(() => {
    setConfig(loadSizingConfig());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // The review read is best-effort like the other two: it only feeds
        // the streak-survival line, and sizing must render without it.
        void fetch("/api/review", { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .then((body: { equityCurve?: { longestLossStreak?: number } } | null) => {
            const n = body?.equityCurve?.longestLossStreak;
            if (!cancelled && typeof n === "number" && n > 0) setLossStreak(n);
          })
          .catch(() => undefined);
        const [posRes, corrRes] = await Promise.all([
          fetch("/api/positions", { cache: "no-store" }),
          fetch("/api/correlation", { cache: "no-store" }),
        ]);
        if (!posRes.ok || !corrRes.ok) return;
        // The positions API's field is `open` — the rows whose monitor state
        // says a position is genuinely running.
        const positions = (await posRes.json()) as { open?: HeldPosition[] };
        const corr = (await corrRes.json()) as { report?: CorrelationReport };
        const held = (positions.open ?? [])
          .filter(
            (p) =>
              !p.paper &&
              (p.state === "entered" || p.state === "added" || p.state === "scaled"),
          )
          .map((p) => p.symbol)
          .filter((s) => s !== symbol);
        const clusters = corr.report?.clusters ?? [];
        const related = held.filter((h) =>
          clusters.some(
            (c) => (c.a === symbol && c.b === h) || (c.b === symbol && c.a === h),
          ),
        );
        if (!cancelled) setCorrelatedHeld(related);
      } catch {
        // Sizing still renders without the correlation refinement.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  if (config.accountSize === null) {
    return (
      <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 px-4 py-3">
        <p className="text-xs text-neutral-500">
          <span className="text-neutral-300">部位大小：</span>
          到 <Link href="/settings" className="underline hover:text-neutral-200">金鑰設定</Link>{" "}
          填入帳戶規模後，這裡會直接算出這筆該下多少（風險金額 ÷ 停損距離）。
          帳戶數字只存在這台裝置，不會上傳。
        </p>
      </div>
    );
  }

  const sizing = positionSize({
    accountSize: config.accountSize,
    riskPct: config.riskPct,
    direction,
    entry,
    stopLoss,
    symbol,
    correlatedHeld,
  });
  if (!sizing) return null;

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-medium text-neutral-200">這筆該下多少</span>
        <span className="text-[10px] text-neutral-600">
          帳戶 {config.accountSize.toLocaleString()} × 風險 {config.riskPct}%
          {sizing.correlationFactor < 1 && " × 相關減半"}
        </span>
      </div>
      <dl className="grid grid-cols-3 gap-2">
        <div>
          <dt className="text-[10px] text-neutral-600">風險金額</dt>
          <dd className="font-mono text-sm text-red-400/80">{sizing.riskAmount.toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-[10px] text-neutral-600">部位（單位）</dt>
          <dd className="font-mono text-sm text-neutral-200">{sizing.units.toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-[10px] text-neutral-600">
            {sizing.lots !== null ? "≈ 手數" : "名目曝險"}
          </dt>
          <dd className="font-mono text-sm text-neutral-200">
            {sizing.lots !== null ? sizing.lots : sizing.notional.toLocaleString()}
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-[10px] leading-relaxed text-neutral-600">
        1 單位 = 價格每動 1 點損益 1 元（報價幣別）。停損觸發時虧損即為風險金額；
        名目曝險 {sizing.notional.toLocaleString()}（約帳戶的 {sizing.leverage} 倍）。
        {sizing.lotLabel ? `手數以${sizing.lotLabel}換算，券商合約規格不同時以單位數自行換算。` : ""}
      </p>
      {sizing.notes.map((n, i) => (
        <p key={i} className="mt-1.5 text-[10px] leading-relaxed text-amber-400/80">
          · {n}
        </p>
      ))}
      {/* 撐得過連敗才輪得到期望值 — the sizing lesson every book buries in
          chapter nine, computed from this account's own % and this system's
          own worst streak. Approximate on purpose (assumes ~1R per loss,
          no compounding) and says so. */}
      {lossStreak !== null && lossStreak >= 2 && (
        <p className="mt-1.5 text-[10px] leading-relaxed text-neutral-500">
          · 本系統實測的最長連敗是 <span className="text-neutral-300">{lossStreak} 筆</span>。
          以單筆風險 {config.riskPct}% 計，重演一次約回撤{" "}
          <span className="text-neutral-300">
            {Math.round(lossStreak * config.riskPct * 10) / 10}%
          </span>
          （約 {Math.round(lossStreak * (config.riskPct / 100) * config.accountSize).toLocaleString()}）
          —— 單筆風險 % 的上限應以「這段回撤發生時你還能照計畫下一單」為準，不是以最大獲利為準。
        </p>
      )}
    </div>
  );
}

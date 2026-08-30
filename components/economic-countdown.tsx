"use client";

import { useEffect, useState } from "react";
import { EVENT_BLACKOUT_MS, fomcTimes, nfpTimeFor } from "@/lib/analysis/timing";
import { formatCountdown } from "@/lib/analysis/sessions";

/**
 * 經濟日曆倒數 — the two releases whose timing is knowable without a key.
 *
 * Around a high-impact print, volatility goes extreme and direction goes
 * random: stops on both sides get taken within the same minute, and a signal
 * that was sound an hour earlier is simply not applicable. The S4 rule already
 * downgrades inside that window server-side; this is the same fact where the
 * reader can act on it — "do not open anything for the next three hours" is a
 * decision only a human makes.
 *
 * Only NFP and FOMC. NFP is arithmetic (first Friday, 12:30 UTC) and the Fed
 * publishes its meeting dates more than a year ahead. CPI is deliberately
 * absent: BLS dates move within the month, and a countdown to a wrong date is
 * worse than no countdown at all.
 */

interface Upcoming {
  label: string;
  at: Date;
  note: string;
}

function nextEvents(now: Date): Upcoming[] {
  const out: Upcoming[] = [];

  // This month's NFP if it is still ahead, otherwise next month's.
  const thisNfp = nfpTimeFor(now.getUTCFullYear(), now.getUTCMonth());
  const nfp = thisNfp.getTime() > now.getTime()
    ? thisNfp
    : nfpTimeFor(now.getUTCFullYear(), now.getUTCMonth() + 1);
  out.push({
    label: "美國非農就業（NFP）",
    at: nfp,
    note: "公布前波動收斂、公布後 1–2 小時劇烈，掛單易被雙向掃損",
  });

  const fomc = fomcTimes().find((d) => d.getTime() > now.getTime());
  if (fomc) {
    out.push({
      label: "FOMC 利率決策",
      at: fomc,
      note: "聲明與記者會是全年波動最大的時段之一，方向常在半小時內反覆",
    });
  }

  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

export function EconomicCountdown() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // Client-only for the same reason as the session strip: a server-rendered
  // countdown is stale the moment it is sent, and the mismatch would be a
  // hydration error rather than a wrong number.
  if (!now) return null;

  const events = nextEvents(now);
  if (events.length === 0) return null;

  // 禁入窗生效中 — the same window the signal builder enforces server-side
  // (EVENT_BLACKOUT_MS), said here in red where the person deciding sees it.
  // Inside it, new entries are refused by rule, not by mood; the reader with
  // a position open gets the standard playbook instead of a surprise.
  const nearest = events[0];
  const nearestMinutes = Math.round((nearest.at.getTime() - now.getTime()) / 60_000);
  const inBlackout = nearest.at.getTime() - now.getTime() <= EVENT_BLACKOUT_MS;

  return (
    <section
      className={`mb-3 rounded-xl border p-3 ${
        inBlackout ? "border-red-500/40 bg-red-500/[0.05]" : "border-neutral-800 bg-neutral-900/40"
      }`}
    >
      {inBlackout && (
        <p className="mb-2 rounded-lg bg-red-500/10 px-2.5 py-2 text-xs leading-relaxed text-red-300">
          <span className="font-medium">⛔ 數據前禁入窗生效中</span> —— {nearest.label}將於{" "}
          {formatCountdown(nearestMinutes)}後公布。公布前 2 小時內系統不建立新倉
          （新訊號一律轉為觀望並註明原因）；已持倉者考慮減半部位或把停損收緊到保本，不要加倉。
        </p>
      )}
      <h2 className="mb-2 text-xs font-medium text-neutral-400">經濟數據倒數</h2>
      <ul className="flex flex-col gap-2">
        {events.map((e) => {
          const minutes = Math.round((e.at.getTime() - now.getTime()) / 60_000);
          const soon = minutes <= 24 * 60;
          return (
            <li key={e.label} className="text-xs">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className={soon ? "font-medium text-amber-300" : "text-neutral-300"}>
                  {soon && "⚠ "}
                  {e.label}
                </span>
                <span className={`font-mono ${soon ? "text-amber-400" : "text-neutral-500"}`}>
                  {formatCountdown(minutes)}後
                </span>
                <span className="text-[11px] text-neutral-500">
                  {e.at.toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
              {soon && <p className="mt-0.5 text-[11px] leading-relaxed text-neutral-500">{e.note}</p>}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[11px] leading-relaxed text-neutral-500">
        只列時間可推算的兩項：NFP（每月第一個週五）與 FOMC（聯準會提前一年公布）。
        CPI 的日期每月浮動，寧可不列也不猜錯。數據前後 24 小時內訊號評等自動降一級；
        公布前 2 小時內是硬規則 —— 不建立新倉。
      </p>
    </section>
  );
}

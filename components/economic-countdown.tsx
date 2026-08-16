"use client";

import { useEffect, useState } from "react";
import { fomcTimes, nfpTimeFor } from "@/lib/analysis/timing";
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

  return (
    <section className="mb-3 rounded-xl border border-neutral-800 bg-neutral-900/40 p-3">
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
                <span className="text-[10px] text-neutral-600">
                  {e.at.toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
              {soon && <p className="mt-0.5 text-[11px] leading-relaxed text-neutral-500">{e.note}</p>}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[10px] leading-relaxed text-neutral-600">
        只列時間可推算的兩項：NFP（每月第一個週五）與 FOMC（聯準會提前一年公布）。
        CPI 的日期每月浮動，寧可不列也不猜錯。數據前後 24 小時內，訊號評等會自動降一級。
      </p>
    </section>
  );
}

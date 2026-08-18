"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SessionStrip } from "@/components/session-strip";
import { cn } from "@/lib/utils";

/**
 * One navigation, everywhere.
 *
 * There used to be seven, one per page, agreeing about nothing: the detail
 * page offered six links, the board four *different* ones, /history and
 * /review two each, and the three settings pages a lone back-arrow. Which
 * page you were on decided where you could go next, so "where is 復盤" had a
 * different answer depending on where you asked — and the settings pages
 * were a cul-de-sac you had to reverse out of.
 *
 * The fix is structural rather than cosmetic: the destinations are declared
 * once, in the order they are used, and every page renders the same bar.
 *
 * ## Why two tiers rather than one row of seven
 *
 * Seven equal links on a phone is a wall of small text where nothing is
 * findable. They are not equal anyway: four are the daily loop (what is
 * tradeable → the analysis → what happened → what it taught), and three are
 * setup you touch when something is wrong. So the daily four are tabs, and
 * the setup three sit after a divider in dimmer, smaller type. Same row when
 * there is width, wrapped when there is not — no dropdown, no menu state,
 * nothing that can be stuck open.
 *
 * ## Why the current page is marked
 *
 * A tab bar that does not say where you are is a tab bar you have to test by
 * clicking. `usePathname` is exact-matched (with a prefix rule for detail
 * routes) so a nested page still lights its section.
 */

interface Destination {
  href: string;
  label: string;
  /** One line, shown as the link's title — what this page answers. */
  hint: string;
}

/**
 * The six-page architecture, in the order a session actually runs:
 * what is the market doing → which instruments rank → this one in detail →
 * what am I holding → what did it all earn.
 */
export const PRIMARY: Destination[] = [
  { href: "/board", label: "總覽", hint: "美元格局、風險情緒、類別強弱、經濟數據倒數" },
  { href: "/ranking", label: "排名", hint: "依趨勢品質排序，附相關性檢查" },
  { href: "/", label: "詳情", hint: "單一商品的完整分析與交易計畫" },
  { href: "/positions", label: "持倉", hint: "追蹤中的部位、移動停損與合併風險敞口" },
  { href: "/review", label: "總結", hint: "成績單、期望值、教訓學習與交易紀錄" },
];

/** Setup — visited when something needs fixing, not every day. */
export const SECONDARY: Destination[] = [
  { href: "/lab", label: "實驗室", hint: "前進實驗與十年回測，驗證通過後可採用為進場門檻" },
  { href: "/history", label: "歷史", hint: "過去產生過的訊號" },
  { href: "/setup", label: "通知", hint: "Telegram／Discord 與資料表" },
  { href: "/settings", label: "金鑰", hint: "AI 與資料源金鑰" },
  { href: "/symbols", label: "標的", hint: "自訂追蹤的商品" },
];

function isCurrent(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  // "/" would prefix-match everything, so the analysis page is exact-only.
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SiteNav({ title }: { title: string }) {
  const pathname = usePathname();

  return (
    <header className="mb-4">
      <h1 className="mb-2 text-base font-bold text-neutral-100">{title}</h1>
      <nav className="flex flex-wrap items-center gap-x-1 gap-y-1.5 border-b border-neutral-800 pb-2">
        {PRIMARY.map((d) => {
          const current = isCurrent(pathname, d.href);
          return (
            <Link
              key={d.href}
              href={d.href}
              title={d.hint}
              aria-current={current ? "page" : undefined}
              className={cn(
                "rounded-lg px-2.5 py-1 text-sm transition-colors",
                current
                  ? "bg-neutral-800 font-medium text-neutral-100"
                  : "text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200",
              )}
            >
              {d.label}
            </Link>
          );
        })}

        <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-neutral-800" />

        {SECONDARY.map((d) => {
          const current = isCurrent(pathname, d.href);
          return (
            <Link
              key={d.href}
              href={d.href}
              title={d.hint}
              aria-current={current ? "page" : undefined}
              className={cn(
                "rounded-lg px-2 py-1 text-xs transition-colors",
                current
                  ? "bg-neutral-800 font-medium text-neutral-200"
                  : "text-neutral-600 hover:bg-neutral-900 hover:text-neutral-300",
              )}
            >
              {d.label}
            </Link>
          );
        })}
      </nav>

      {/* 全站常駐：a 24-hour market has no bell, so every page says which
          session produced the numbers on it. */}
      <div className="mt-2">
        <SessionStrip />
      </div>
    </header>
  );
}

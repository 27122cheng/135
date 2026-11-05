import type { TradeSignal } from "@/types/signal";

/**
 * 瀏覽器模式 — the last scan of each symbol, kept in this device's browser.
 *
 * 「改成跟其他一樣」: the operator's other analysis sites keep their records
 * in the browser and never need a server-side store. With no database
 * configured this site now does the same: a scan's result is saved here,
 * the board is rebuilt from here, and the detail page reads from here.
 * What this cannot do is the part that happens while no browser is open —
 * scheduled scans, monitoring, Telegram, learning — and the board says so.
 *
 * One entry per symbol, newest wins; nine full signals fit well inside the
 * 5 MB a browser allows. Every read and write is guarded: storage can be
 * blocked (private mode, a quota), and a blocked store must not break the
 * page that was working without it.
 */

const KEY = "local-signals:v1";

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function readAll(): Record<string, TradeSignal> {
  const s = storage();
  if (!s) return {};
  try {
    const raw = s.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, TradeSignal>)
      : {};
  } catch {
    return {};
  }
}

export function loadLocalSignals(): TradeSignal[] {
  return Object.values(readAll()).filter((s) => s && typeof s.symbol === "string");
}

export function loadLocalSignal(symbol: string): TradeSignal | null {
  return readAll()[symbol.toUpperCase()] ?? null;
}

export function saveLocalSignal(signal: TradeSignal): boolean {
  const s = storage();
  if (!s || !signal?.symbol) return false;
  const all = readAll();
  all[signal.symbol.toUpperCase()] = signal;
  try {
    s.setItem(KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

export function clearLocalSignals(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    // nothing to clear
  }
}

/** The scan route's own words for "no database" — the one storeError that is not an error here. */
export function isNoDatabase(message: string | null | undefined): boolean {
  return typeof message === "string" && message.includes("未設定資料庫");
}

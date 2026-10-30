import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, report } from "./_harness";

/** 瀏覽器模式 — the browser is the store when there is no database. */

// A fake window.localStorage for the module under test.
const mem = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  },
};

async function main() {
  const { clearLocalSignals, isNoDatabase, loadLocalSignal, loadLocalSignals, saveLocalSignal } =
    await import("@/lib/local-signals");
  const sig = (symbol: string, at: string) =>
    ({ symbol, generated_at: at, direction: "long", grade: "B", trade_plan: { stance: "wait" } }) as never;

  check("an empty store reads as nothing", loadLocalSignals().length === 0);
  check("a scan is kept", saveLocalSignal(sig("XAUUSD", "2026-10-30T01:00:00Z")) && loadLocalSignal("xauusd") !== null);
  saveLocalSignal(sig("EURUSD", "2026-10-30T01:00:00Z"));
  saveLocalSignal(sig("XAUUSD", "2026-10-30T02:00:00Z"));
  check("one entry per symbol, newest wins",
    loadLocalSignals().length === 2 && (loadLocalSignal("XAUUSD") as { generated_at: string }).generated_at.endsWith("02:00:00Z"));
  clearLocalSignals();
  check("clear empties it", loadLocalSignals().length === 0);
  mem.set("local-signals:v1", "not json");
  check("corrupt storage reads as nothing, never throws", loadLocalSignals().length === 0);
  check("the scan route's no-database message is recognised", isNoDatabase("未設定資料庫，掃描結果無處可存") && !isNoDatabase("connection refused"));

  const root = join(__dirname, "..");
  const route = readFileSync(join(root, "app", "api", "board", "route.ts"), "utf8");
  const board = readFileSync(join(root, "app", "board", "page.tsx"), "utf8");
  const home = readFileSync(join(root, "app", "page.tsx"), "utf8");
  check("the board route shapes browser-held signals into rows", route.includes("export async function POST") && route.includes('source: "browser"'));
  check("the board falls into browser mode on a 501 and rebuilds from local signals",
    board.includes("res.status === 501") && board.includes("loadLocalSignals()") && board.includes('method: "POST"'));
  check("a rescan in browser mode keeps its result instead of failing on 'no database'",
    board.includes("isNoDatabase(body.storeError) && body.signal") && board.includes("saveLocalSignal(body.signal)"));
  check("the board says what the mode cannot do", board.includes("瀏覽器模式：沒有設定資料庫"));
  check("the detail page reads and writes the same store", home.includes("loadLocalSignal(selected)") && home.includes("saveLocalSignal(signalData)"));
}

main().then(() => report("browser mode"));

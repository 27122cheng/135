import { check, report } from "./_harness";
import { __resetBookMemoForTests, openRealPositionCount } from "@/lib/monitor/book";
import type { MonitorRow, SignalStore } from "@/lib/db";

/** 同時持倉上限 — counted from the monitor's own rows, one read per minute. */

function storeWith(states: Record<string, string>) {
  let calls = 0;
  const store = {
    async getMonitorState(symbol: string): Promise<MonitorRow | null> {
      calls++;
      const st = states[symbol];
      return st ? ({ symbol, state: st, addOnsFilled: 0, activeStop: null, signalId: null, lastPrice: null } as MonitorRow) : null;
    },
  } as unknown as SignalStore;
  return { store, calls: () => calls };
}

async function main() {
  __resetBookMemoForTests();
  const a = storeWith({ XAUUSD: "entered", EURUSD: "added", WTI: "scaled", USDJPY: "waiting", NAS100: "stop_hit" });
  const n = await openRealPositionCount(a.store);
  check("entered, added and scaled count as open; waiting and resolved do not", n === 3, n);
  const before = a.calls();
  const again = await openRealPositionCount(a.store);
  check("the second call within a minute is served from the memo", again === 3 && a.calls() === before, a.calls());

  __resetBookMemoForTests();
  const b = storeWith({});
  check("an empty book is zero", (await openRealPositionCount(b.store)) === 0);

  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const builder = readFileSync(join(__dirname, "..", "lib", "signal-builder.ts"), "utf8");
  check("the builder turns an enter into a wait when the book is full",
    builder.includes("open >= MAX_OPEN_POSITIONS") && builder.includes("同時持倉已達上限"));
  const gate = builder.indexOf("openRealPositionCount(store)");
  const cooldown = builder.indexOf("stopCooldown(symbolJournal");
  check("before the cooldown and breaker, so the book's rule is the reason shown", gate > 0 && gate < cooldown);
}

main().then(() => report("book gate"));

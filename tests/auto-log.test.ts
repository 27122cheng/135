import { check, report } from "./_harness";
import { journalSignalId, recordResolvedPlan } from "@/lib/journal/auto-log";
import type { SignalStore } from "@/lib/db";
import type { JournalEntry, JournalEntryInput } from "@/types/journal";
import type { CommodityMeta, SignalRow } from "@/types/signal";

// ── 自動日誌的 signal_id 必須是 uuid，否則資料庫拒收 ───────────────
//
// trade_journal.signal_id is a uuid column. The row the monitor resolves
// against comes from latest_signal, whose id is the SYMBOL ("XAUUSD"), so
// every auto-written resolution was rejected by postgres with "invalid input
// syntax for type uuid" and swallowed into a note. plan_monitor's write right
// beside it already guarded for this; the journal write did not.

const UUID = "3f2c9d5e-8a1b-4c7d-9e2f-1a2b3c4d5e6f";

check("a uuid passes through", journalSignalId(UUID) === UUID);
check("a symbol standing in for an id becomes null", journalSignalId("XAUUSD") === null);
check("null stays null", journalSignalId(null) === null);
check("undefined becomes null", journalSignalId(undefined) === null);
check("a 36-char non-uuid is not enough", journalSignalId("x".repeat(36)) === null);

function fakeStore(existing: JournalEntry[] = []) {
  const written: JournalEntryInput[] = [];
  const store = {
    async listJournal() {
      return existing;
    },
    async insertJournalEntry(entry: JournalEntryInput, severity: number | null) {
      written.push(entry);
      return { ...entry, id: `j-${written.length}`, severity, created_at: new Date().toISOString() } as JournalEntry;
    },
  } as unknown as SignalStore;
  return { store, written };
}

const meta = { symbol: "XAUUSD", label: "黃金", category: "metal" } as CommodityMeta;

function signal(id: string): SignalRow {
  return {
    id,
    symbol: "XAUUSD",
    direction: "long",
    grade: "B",
    generated_at: new Date().toISOString(),
  } as unknown as SignalRow;
}

async function resolveTarget(store: SignalStore, id: string) {
  return recordResolvedPlan({
    store,
    meta,
    signal: signal(id),
    entry: 2000,
    stopLoss: 1980,
    takeProfit: 2060,
    exitPrice: 2060,
    outcome: "target_hit",
    paper: false,
    eventDuringHold: false,
    gaps: [],
  });
}

async function main() {
  {
    const { store, written } = fakeStore();
    const out = await resolveTarget(store, "XAUUSD");
    check("a latest_signal row (id = symbol) is journalled", out.entry !== null, out.note);
    check("with signal_id null rather than the symbol", written[0]?.signal_id === null, written[0]?.signal_id);
    check("and the trade itself is intact", written[0]?.result === "win" && written[0]?.symbol === "XAUUSD", written[0]);
  }

  {
    const { store, written } = fakeStore();
    await resolveTarget(store, UUID);
    check("a history row's uuid is kept", written[0]?.signal_id === UUID, written[0]?.signal_id);
  }

  {
    // Idempotency compares the normalised id: a resolution already stored with
    // signal_id null must match the symbol-id signal that produced it, or the
    // same trade is written again on the next sweep.
    const prior = {
      id: "j-0",
      signal_id: null,
      symbol: "XAUUSD",
      direction: "long",
      grade: "B",
      entry_price: 2000,
      exit_price: 2060,
      result: "win",
      pnl_pct: 3,
      closed_at: new Date().toISOString(),
      stop_reason_tag: null,
      severity: null,
      review_note: "[自動追蹤] 觸及停利",
      created_at: new Date().toISOString(),
    } as unknown as JournalEntry;
    const { store, written } = fakeStore([prior]);
    const out = await resolveTarget(store, "XAUUSD");
    check("a resolution already written is not written twice", written.length === 0 && out.entry === null, out.note);
  }

  // ── 提早出場的虧損也要有原因 ─────────────────────────────────────
  {
    // No candles (fetch fails) → bestPrice null → the rules still classify.
    globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
    const { store, written } = fakeStore();
    const out = await recordResolvedPlan({
      store, meta, signal: signal("XAUUSD"), entry: 2000, stopLoss: 1980, takeProfit: 2060,
      exitPrice: 1990, outcome: "structure_exit", paper: false, eventDuringHold: false, gaps: [],
    });
    check("a losing structure exit is journalled", out.entry !== null, out.note);
    check("with an S-tag, so it reaches 停損原因分布 and the interventions",
      typeof written[0]?.stop_reason_tag === "string" && /^S[1-8]$/.test(written[0].stop_reason_tag), written[0]);
    check("and the note still names the exit kind", written[0]?.review_note?.includes("結構翻轉出場") === true, written[0]?.review_note);
    check("the push carries the classification", out.outcome?.tag !== null && out.outcome?.kind === "結構翻轉出場", out.outcome);

    const win = fakeStore();
    const w = await recordResolvedPlan({
      store: win.store, meta, signal: signal("XAUUSD"), entry: 2000, stopLoss: 1980, takeProfit: 2060,
      exitPrice: 2030, outcome: "thesis_exit", paper: false, eventDuringHold: false, gaps: [],
    });
    check("a winning early exit stays untagged — nothing to fix",
      w.entry !== null && win.written[0]?.stop_reason_tag === null, win.written[0]);
  }
}

main().then(() => report("auto-log signal_id"));

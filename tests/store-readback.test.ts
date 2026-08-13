import { check, report } from "./_harness";
import { storeScan } from "@/lib/scan";
import type { SignalStore } from "@/lib/db";
import type { SignalRow, TradeSignal } from "@/types/signal";

/**
 * The write that lies.
 *
 * For a full day every hourly sweep reported `storeError: null` on all nine
 * symbols while the board and the monitor kept reading a world frozen the
 * previous morning. No write ever threw: the inserts were accepted and
 * committed — by a database branch the platform had minted for that one
 * deployment and that no later request ever saw again (Vercel's Neon
 * integration can be configured to branch per deploy). `storeScan` therefore
 * re-reads what it just wrote and treats "accepted but not there" as the
 * storage failure it is. These pin that contract.
 */

function signal(): TradeSignal {
  return {
    symbol: "XAUUSD",
    generated_at: new Date().toISOString(),
  } as unknown as TradeSignal;
}

/**
 * A store whose reads serve whatever the writes recorded — the honest case —
 * with switches to drop each side, mimicking the branch-rotation failure where
 * writes resolve fine and reads come back empty.
 */
function fakeStore(over: {
  dropLatest?: boolean;
  dropHistory?: boolean;
  throwOnSave?: boolean;
  throwOnReads?: boolean;
}): SignalStore {
  const latest: TradeSignal[] = [];
  const history: TradeSignal[] = [];
  return {
    kind: "postgres",
    saveLatest: async (s: TradeSignal) => {
      if (over.throwOnSave) throw new Error("relation \"latest_signal\" does not exist");
      latest.push(s);
    },
    insertSignal: async (s: TradeSignal) => {
      history.push(s);
    },
    latestPerSymbol: async () => {
      if (over.throwOnReads) throw new Error("read side down");
      return (over.dropLatest ? [] : latest) as unknown as SignalRow[];
    },
    listSignals: async () => {
      if (over.throwOnReads) throw new Error("read side down");
      return (over.dropHistory ? [] : [...history].reverse()) as unknown as SignalRow[];
    },
  } as unknown as SignalStore;
}

async function suite() {
  // ── writes that persist verify clean ──────────────────────────────
  {
    const r = await storeScan(signal(), fakeStore({}));
    check("a write that reads back is stored", r.stored === true);
    check("with no error", r.storeError === null, r.storeError);
  }

  // ── both tables lose the row: the branch-rotation failure ─────────
  {
    const r = await storeScan(signal(), fakeStore({ dropLatest: true, dropHistory: true }));
    check("a write nothing can read back is NOT stored", r.stored === false);
    check("and says the write was accepted then lost",
      r.storeError?.includes("寫入宣稱成功") === true, r.storeError);
    check("naming both tables",
      r.storeError?.includes("latest_signal 與 signals") === true, r.storeError);
    check("and the likely cause by name",
      r.storeError?.includes("分支") === true, r.storeError);
  }

  // ── the database's own account rides along ────────────────────────
  {
    const store = fakeStore({ dropLatest: true, dropHistory: true });
    (store as { snapshot?: () => Promise<Record<string, unknown>> }).snapshot = async () => ({
      db: "neondb",
      signal_rows: 42,
      newest_signal: "2026-08-11T05:08:53Z",
    });
    const r = await storeScan(signal(), store);
    check("a failed read-back quotes the database's self-description",
      r.storeError?.includes("資料庫自述") === true &&
        r.storeError?.includes("2026-08-11T05:08:53Z") === true,
      r.storeError);
  }

  // ── only latest_signal loses the row ──────────────────────────────
  {
    const r = await storeScan(signal(), fakeStore({ dropLatest: true }));
    // The history row survived, so the scan is not wholly lost — but the
    // board reads latest_signal, and a reader must be told why it is stale.
    check("a half-lost write is still reported", r.storeError !== null, r.storeError);
    check("as partial, not total", r.stored === true);
    check("naming the table that lost it",
      r.storeError?.includes("latest_signal") === true, r.storeError);
  }

  // ── a throwing write keeps its own error ──────────────────────────
  {
    const r = await storeScan(signal(), fakeStore({ throwOnSave: true }));
    check("a thrown write is reported as before",
      r.storeError?.includes("目前訊號（latest_signal）") === true, r.storeError);
    check("one failed write of two still counts as stored", r.stored === true);
  }

  // ── an unverifiable write is not a lost write ─────────────────────
  {
    const r = await storeScan(signal(), fakeStore({ throwOnReads: true }));
    check("a read-back that itself fails proves nothing", r.storeError === null, r.storeError);
    check("and the write stands", r.stored === true);
  }

  // ── no store at all ───────────────────────────────────────────────
  {
    const r = await storeScan(signal(), null);
    check("no database is its own message",
      r.storeError?.includes("未設定資料庫") === true, r.storeError);
    check("and nothing is stored", r.stored === false);
  }
}

void suite().then(() => report("store-readback"));

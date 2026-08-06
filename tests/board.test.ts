import { check, report } from "./_harness";
import { readLatest } from "@/lib/latest-signals";
import type { SignalStore } from "@/lib/db";
import type { SignalRow, TradeSignal } from "@/types/signal";

/**
 * The board's read path.
 *
 * The bug being pinned: `latest_signal` was added after the schema had already
 * been applied to live deployments, and `/api/refresh` writes to it inside a
 * catch so a missing table cannot fail a refresh that already stored its
 * history row. The result was a board reading 已掃描 0/9 for days while
 * /history filled up normally, with nothing anywhere saying why.
 */

function row(symbol: string, generatedAt: string): SignalRow {
  return {
    id: `${symbol}-${generatedAt}`,
    created_at: generatedAt,
    symbol,
    generated_at: generatedAt,
  } as unknown as SignalRow;
}

/** Only the two methods readLatest touches; the rest would never be called. */
function store(over: Partial<SignalStore>): SignalStore {
  return {
    latestPerSymbol: async () => [],
    listSignals: async () => [],
    ...over,
  } as unknown as SignalStore;
}

async function suite() {
  // ── the happy path ────────────────────────────────────────────────
  {
    const rows = [row("XAUUSD", "2026-08-06T00:00:00Z")];
    const read = await readLatest(store({ latestPerSymbol: async () => rows }));
    check("latest_signal is used when it has rows", read.source === "latest_signal", read.source);
    check("and nothing is flagged", read.note === null, read.note);
    check("the rows come through", read.rows.length === 1);
  }

  // ── the table is missing ──────────────────────────────────────────
  {
    let historyAsked = false;
    const read = await readLatest(
      store({
        latestPerSymbol: async () => {
          throw new Error('relation "latest_signal" does not exist');
        },
        listSignals: async () => {
          historyAsked = true;
          return [row("XAUUSD", "2026-08-06T00:00:00Z"), row("EURUSD", "2026-08-05T20:00:00Z")];
        },
      }),
    );
    check("a throwing latest_signal falls back to history", historyAsked);
    check("the board still gets its rows", read.rows.length === 2, read.rows.length);
    check("the source says so", read.source === "signals", read.source);
    check("and the reason is passed on verbatim",
      read.note?.includes("does not exist") === true, read.note);
    check("with the fix named", read.note?.includes("建立資料表") === true, read.note);
  }

  // ── the table exists but is empty ─────────────────────────────────
  {
    const read = await readLatest(
      store({
        listSignals: async () => [row("WTI", "2026-08-06T01:00:00Z")],
      }),
    );
    check("an empty latest_signal also falls back", read.rows.length === 1);
    check("and is flagged", read.note !== null, read.note);
  }

  // ── newest wins ───────────────────────────────────────────────────
  {
    // listSignals returns generated_at desc, so the first row per symbol is the
    // current one. Taking a later duplicate would put a stale plan on the board
    // while claiming it was current — worse than showing nothing.
    const read = await readLatest(
      store({
        listSignals: async () => [
          row("XAUUSD", "2026-08-06T04:00:00Z"),
          row("XAUUSD", "2026-08-06T00:00:00Z"),
          row("EURUSD", "2026-08-05T20:00:00Z"),
        ],
      }),
    );
    check("one row per symbol", read.rows.length === 2, read.rows.length);
    const gold = read.rows.find((r) => r.symbol === "XAUUSD");
    check("and it is the newest one",
      (gold as TradeSignal).generated_at === "2026-08-06T04:00:00Z",
      (gold as TradeSignal | undefined)?.generated_at);
  }

  // ── nothing anywhere ──────────────────────────────────────────────
  {
    const read = await readLatest(store({}));
    check("an empty database is not an error", read.rows.length === 0);
    // Nothing has ever been scanned — that is a true and complete answer, and
    // telling the owner to go fix a table would be inventing a fault.
    check("and produces no misleading note", read.note === null, read.note);
  }
}

// Wrapped: the test runner transforms to CJS, which has no top-level await.
void suite().then(() => report("board"));

import { check, report } from "./_harness";
import { readLatest } from "@/lib/latest-signals";
import type { SignalStore } from "@/lib/db";
import { COMMODITIES, type SignalRow, type TradeSignal } from "@/types/signal";
import { toBoardRow, usdExposure } from "@/lib/board-row";

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

  // ── a history row must still be a whole signal ────────────────────
  //
  // The crash this pins: `signals` has no column for interventions,
  // news_digest or direction_tie, so a row read from it arrives with those
  // fields undefined. /api/board?symbol= feeds the same row to the detail
  // page, where `signal.interventions.length` threw during render and the
  // whole page went black with "Application error: a client-side exception".
  // The fallback caused it; the fallback has to fix it.
  {
    const bare = {
      id: "x", created_at: "2026-08-06T06:00:00Z", symbol: "XAUUSD",
      generated_at: "2026-08-06T06:00:00Z",
    } as unknown as SignalRow;
    const read = await readLatest(store({ listSignals: async () => [bare] }));
    const s = read.rows[0];
    check("interventions is a list", Array.isArray(s.interventions));
    check("bias_items is a list", Array.isArray(s.bias_items));
    check("entry_structures is a list", Array.isArray(s.entry_structures));
    check("path_obstacles is a list", Array.isArray(s.path_obstacles));
    check("take_profits is a list", Array.isArray(s.take_profits));
    check("data_gaps is a list", Array.isArray(s.data_gaps));
    check("news_digest is null, not undefined", s.news_digest === null);
    check("plan_backtest is null, not undefined", s.plan_backtest === null);
    check("direction_tie is false, not undefined", s.direction_tie === false);
    // Not invented. A missing column means the number was never computed, and
    // the card recomputes it from the signal rather than being handed a zero.
    check("confidence is left absent", s.confidence === undefined);

    // The same holes appear in a latest_signal payload written by an older
    // build, so that path is normalised too.
    const viaLatest = await readLatest(store({ latestPerSymbol: async () => [bare] }));
    check("latest_signal rows are normalised as well",
      Array.isArray(viaLatest.rows[0].interventions));
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

// ── the row the board actually renders ────────────────────────────
//
// 參考價位 kept coming back missing on the live board, and the reason it was
// hard to pin down is that nothing in the pipeline asserts the mapping. These
// build a row shaped the way each of the two source tables produces it and
// check the reference levels survive the trip.
{
  const levels = {
    entry_zone: { low: 3300, high: 3312, reason: "現價區間" },
    stop_loss: { price: 3270, structure: "H4 前低", reason: "跌破失效", invalidation: "收破" },
    take_profits: [
      { price: 3360, structure: "H4 前高", reason: "前高", allocation_pct: 50 },
      { price: 3400, structure: "D1 前高", reason: "日線前高", allocation_pct: 50 },
    ],
  };
  const meta = COMMODITIES.find((c) => c.symbol === "XAUUSD")!;

  // As `select * from signals` returns it: no confidence column, no
  // direction_tie column — both were added after this table, and a row that
  // predates them must still produce reference levels.
  const historyRow = {
    id: "abc",
    created_at: "2026-08-06T06:32:28Z",
    symbol: "XAUUSD",
    direction: "long",
    grade: "B",
    generated_at: "2026-08-06T06:32:28Z",
    data_gaps: ["a", "b", "c"],
    trade_plan: {
      stance: "wait",
      entry: null,
      stop_loss: null,
      take_profit: null,
      wait_for: "等待評等升到 B 以上",
      summary: "依計分規則觀望。",
      add_ons: [],
    },
    ...levels,
  } as unknown as SignalRow;

  const built = toBoardRow(meta, historyRow);
  check("a history row still yields reference levels", built.reference !== null);
  check("the entry zone survives", built.reference?.entryLow === 3300);
  check("the stop survives", built.reference?.stopLoss === 3270);
  check("both targets survive", built.reference?.takeProfits.length === 2);
  check("allocation comes through", built.reference?.takeProfits[0].allocationPct === 50);
  // The whole point: a row with no trade is exactly the row that needs these.
  check("and it is a no-trade row", built.stance === "wait");
  check("a missing confidence column is not fatal", built.confidence === null);
  check("a missing direction_tie column reads false", built.directionTie === false);

  // A symbol never scanned has nothing to show and must say so with null
  // rather than an empty-looking box of zeroes.
  check("an unscanned symbol has no reference", toBoardRow(meta, undefined).reference === null);

  // A stored signal from a run where the price feed failed carries a null
  // price. Rendering "止損 null" would be worse than rendering nothing.
  const priceless = { ...historyRow, stop_loss: { ...levels.stop_loss, price: null } } as unknown as SignalRow;
  check("a null stop price yields no reference", toBoardRow(meta, priceless).reference === null);
}

// ── 美元同向曝險 ──────────────────────────────────────────────────
//
// EURUSD long + gold long is short-the-dollar twice; the per-symbol cards
// cannot see that, so the board aggregates it. FX and gold only — indices
// correlate with the dollar too loosely for a sign table to claim them.
{
  const row = (symbol: string, stance: "enter" | "wait", direction: "long" | "short") =>
    ({ symbol, stance, direction }) as never;

  const cluster = usdExposure([
    row("EURUSD", "enter", "long"),
    row("XAUUSD", "enter", "long"),
    row("USDJPY", "enter", "short"),
    row("US30", "enter", "long"),
  ]);
  check("three short-USD entries read as one cluster",
    cluster?.side === "short" && cluster.symbols.length === 3, cluster);
  check("indices are not claimed", !(cluster?.symbols ?? []).includes("US30"), cluster);

  check("a single trade is not a cluster",
    usdExposure([row("EURUSD", "enter", "long")]) === null);
  check("觀望 rows do not count",
    usdExposure([row("EURUSD", "wait", "long"), row("XAUUSD", "wait", "long")]) === null);
  check("opposing USD sides do not merge",
    usdExposure([row("EURUSD", "enter", "long"), row("USDJPY", "enter", "long")]) === null);
}

// Wrapped: the test runner transforms to CJS, which has no top-level await.
void suite().then(() => report("board"));

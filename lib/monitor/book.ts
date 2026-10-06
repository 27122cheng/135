import type { SignalStore } from "@/lib/db";
import { allInstruments } from "@/lib/server-symbols";
import { COMMODITIES } from "@/types/signal";

/**
 * 整本帳有幾筆真實部位在跑 — for the signal builder's book-full gate.
 *
 * The sizing card refuses a fifth position, but the signal itself still
 * said 進場 and the phone still got the push; the reader was told to take a
 * trade the book could not hold. The gate belongs where the recommendation
 * is made. One read per minute for the whole sweep (nine builders run
 * together and would otherwise each walk the roster), memoised on the
 * promise so concurrent callers share one set of queries.
 */

const OPEN_STATES = new Set(["entered", "added", "scaled"]);
const MEMO_MS = 60_000;
let memo: { at: number; value: Promise<number> } | null = null;

export async function openRealPositionCount(store: SignalStore): Promise<number> {
  const now = Date.now();
  if (memo && now - memo.at < MEMO_MS) return memo.value;
  const value = (async () => {
    const roster = await allInstruments().catch(() => [...COMMODITIES]);
    const rows = await Promise.all(
      roster.map((m) => store.getMonitorState(m.symbol).catch(() => null)),
    );
    return rows.filter((r) => r && OPEN_STATES.has(r.state)).length;
  })();
  memo = { at: now, value };
  // A failed read must not be remembered as "zero open" for a minute.
  value.catch(() => {
    memo = null;
  });
  return value;
}

export function __resetBookMemoForTests(): void {
  memo = null;
}

import { COMMODITIES } from "@/types/signal";
import { getSignalStore } from "@/lib/db";
import { readLatest } from "@/lib/latest-signals";
import { toBoardRow } from "@/lib/board-row";
import { json } from "@/lib/json-response";

export type { BoardAddOn, BoardReference, BoardRow } from "@/lib/board-row";

export const dynamic = "force-dynamic";

/**
 * 交易總覽 — every symbol's current plan, in one request.
 *
 * Reads the stored signals rather than building them. That is the whole point:
 * a full pipeline per symbol is what made switching instruments a long wait,
 * and the scheduled refresh has already paid that cost for all nine. This is a
 * single query over the results.
 *
 * The payload is deliberately narrow — direction, grade, the three prices and
 * whether add-ons exist. A signal row carries bias items, structures,
 * obstacles, the narrative and the gap list; shipping all of that to a page
 * that shows a list would make the "instant" board slower than the thing it
 * replaced.
 */

export async function GET(request: Request) {
  const wanted = new URL(request.url).searchParams.get("symbol")?.toUpperCase();
  const store = getSignalStore();
  if (!store) {
    return json(
      {
        error: "未設定資料庫",
        next: "總覽讀的是掃描寫進資料庫的結果。到 /setup 建立資料表。",
        rows: [],
      },
      { status: 501 },
    );
  }

  try {
    const { rows: latest, source, note } = await readLatest(store);
    const bySymbol = new Map(latest.map((r) => [r.symbol, r]));

    // `?symbol=` returns the full stored signal, which is what the detail page
    // renders. Same row, same endpoint — the board and the analysis page
    // cannot show different numbers because there is only one number.
    if (wanted) {
      const row = bySymbol.get(wanted);
      return json({ signal: row ?? null }, { status: row ? 200 : 404 });
    }
    // Driven by COMMODITIES, not by what the query returned, so a symbol that
    // has never been scanned appears as an empty row instead of vanishing —
    // "no data yet" and "no trade" are different answers.
    const rows = COMMODITIES.map((meta) => toBoardRow(meta, bySymbol.get(meta.symbol)));

    return json({
      rows,
      source,
      note,
      // Which build answered. Three times now a fix has been reported as "still
      // the same" and there was no way to tell from the outside whether the
      // deployment had picked it up — the browser shows a page, not a commit.
      // Vercel sets this at build time; locally it is simply absent.
      build: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      tradeCount: rows.filter((r) => r.stance === "enter").length,
      scannedCount: rows.filter((r) => r.generatedAt !== null).length,
      oldestAt: rows.reduce<string | null>(
        (oldest, r) =>
          r.generatedAt && (!oldest || r.generatedAt < oldest) ? r.generatedAt : oldest,
        null,
      ),
    });
  } catch (err) {
    return json(
      {
        error: err instanceof Error ? err.message : String(err),
        next: "latest_signal 資料表可能還沒建立。到 /setup 按「建立資料表」。",
        rows: [],
      },
      { status: 500 },
    );
  }
}

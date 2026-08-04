import { neon } from "@neondatabase/serverless";
import type { SignalRow, TradeSignal } from "@/types/signal";
import type { JournalEntry, JournalEntryInput } from "@/types/journal";
import type { HistoryFilter, SignalStore } from "./index";

/**
 * Plain Postgres over HTTP, via Neon's driver.
 *
 * The driver speaks to Neon's HTTP endpoint and to any standard Postgres
 * connection string, which is what makes `DATABASE_URL` a true switch: point
 * it at Neon's free tier, at Supabase's own Postgres, or at anything else, and
 * nothing in this file changes.
 *
 * HTTP rather than a TCP pool because serverless functions are short-lived —
 * a connection pool would be created and thrown away on every invocation, and
 * free tiers cap connections hard.
 */
export function postgresStore(connectionString: string): SignalStore {
  const sql = neon(connectionString);

  return {
    kind: "postgres",

    async insertSignal(signal: TradeSignal): Promise<void> {
      // Parameterised throughout — every value here is interpolated by the
      // driver, never concatenated into the statement.
      await sql`
        insert into signals (
          symbol, direction, grade, bias_score, entry_structure_score, total_score,
          entry_zone, stop_loss, take_profits, bias_items, entry_structures,
          path_obstacles, narrative, trade_plan, plan_backtest, data_gaps, generated_at
        ) values (
          ${signal.symbol}, ${signal.direction}, ${signal.grade}, ${signal.bias_score},
          ${signal.entry_structure_score}, ${signal.total_score},
          ${JSON.stringify(signal.entry_zone)}, ${JSON.stringify(signal.stop_loss)},
          ${JSON.stringify(signal.take_profits)}, ${JSON.stringify(signal.bias_items)},
          ${JSON.stringify(signal.entry_structures)}, ${JSON.stringify(signal.path_obstacles)},
          ${signal.narrative}, ${JSON.stringify(signal.trade_plan)},
          ${signal.plan_backtest === null ? null : JSON.stringify(signal.plan_backtest)},
          ${JSON.stringify(signal.data_gaps)}, ${signal.generated_at}
        )
      `;
    },

    async listSignals(filter: HistoryFilter): Promise<SignalRow[]> {
      // Each filter is optional, so rather than assembling SQL by hand the
      // predicates are written as "parameter is null OR column matches" — the
      // statement stays constant and every value stays a bound parameter.
      const rows = await sql`
        select * from signals
        where (${filter.symbol ?? null}::text is null or symbol = ${filter.symbol ?? null})
          and (${filter.grade ?? null}::text is null or grade = ${filter.grade ?? null})
          and (${filter.from ?? null}::timestamptz is null or generated_at >= ${filter.from ?? null})
          and (${filter.to ?? null}::timestamptz is null or generated_at <= ${filter.to ?? null})
        order by generated_at desc
        limit ${filter.limit}
      `;
      return rows as unknown as SignalRow[];
    },

    async insertJournalEntry(
      entry: JournalEntryInput,
      severity: number | null,
    ): Promise<JournalEntry> {
      const rows = await sql`
        insert into trade_journal (
          signal_id, symbol, direction, grade, entry_price, exit_price,
          result, pnl_pct, closed_at, stop_reason_tag, severity, review_note
        ) values (
          ${entry.signal_id}, ${entry.symbol}, ${entry.direction}, ${entry.grade},
          ${entry.entry_price}, ${entry.exit_price}, ${entry.result}, ${entry.pnl_pct},
          ${entry.closed_at}, ${entry.stop_reason_tag}, ${severity}, ${entry.review_note}
        )
        returning *
      `;
      return rows[0] as unknown as JournalEntry;
    },

    async listJournal(options: { symbol?: string | null; limit: number }): Promise<JournalEntry[]> {
      const rows = await sql`
        select * from trade_journal
        where (${options.symbol ?? null}::text is null or symbol = ${options.symbol ?? null})
        order by closed_at desc
        limit ${options.limit}
      `;
      return rows as unknown as JournalEntry[];
    },
  };
}

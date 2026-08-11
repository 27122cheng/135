import { neon } from "@neondatabase/serverless";
import type { SignalRow, TradeSignal } from "@/types/signal";
import type { JournalEntry, JournalEntryInput } from "@/types/journal";
import type {
  HistoryFilter,
  MonitorRow,
  ReleaseRow,
  SignalStore,
  StoredRelease,
} from "./index";
import type { PlanState } from "@/lib/monitor/plan-state";

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

/**
 * Turns the two failures a first-time setup actually hits into instructions.
 *
 * Postgres says `relation "trade_journal" does not exist`, which is accurate
 * and useless to someone who has just pasted a connection string and doesn't
 * know a schema step exists. Everything else is passed through unchanged —
 * inventing friendly text for an unknown error would hide it.
 */
export function explain(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/relation ".*" does not exist/i.test(message)) {
    return new Error(
      `資料表尚未建立 —— 請先對這個資料庫執行 supabase/schema.sql（純 SQL，Neon 與 Supabase 都適用）。原始錯誤：${message}`,
    );
  }
  if (/password authentication failed|no pg_hba|SASL/i.test(message)) {
    return new Error(
      `資料庫連線被拒，請確認 DATABASE_URL 正確且包含密碼。原始錯誤：${message}`,
    );
  }
  return new Error(message);
}

export function postgresStore(connectionString: string): SignalStore {
  const sql = neon(connectionString);

  return {
    kind: "postgres",

    async insertSignal(signal: TradeSignal): Promise<void> {
      try {
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
      } catch (err) {
        throw explain(err);
      }
    },

    async listSignals(filter: HistoryFilter): Promise<SignalRow[]> {
      try {
        // Each filter is optional, so rather than assembling SQL by hand the
        // predicates are written as "parameter is null OR column matches" — the
        // statement stays constant and every value stays a bound parameter.
        const rows = await sql`
        select * from signals
        where (${filter.symbol ?? null}::text is null or symbol = ${filter.symbol ?? null})
          and (${filter.grade ?? null}::text is null or grade = ${filter.grade ?? null})
          and (${filter.stance ?? null}::text is null or trade_plan->>'stance' = ${filter.stance ?? null})
          and (${filter.from ?? null}::timestamptz is null or generated_at >= ${filter.from ?? null})
          and (${filter.to ?? null}::timestamptz is null or generated_at <= ${filter.to ?? null})
        order by generated_at desc
        limit ${filter.limit}
      `;
        return rows as unknown as SignalRow[];
      } catch (err) {
        throw explain(err);
      }
    },

    async saveLatest(signal: TradeSignal): Promise<void> {
      try {
        await sql`
          insert into latest_signal (symbol, payload, generated_at, updated_at)
          values (${signal.symbol}, ${JSON.stringify(signal)}, ${signal.generated_at}, now())
          on conflict (symbol) do update set
            payload = excluded.payload,
            generated_at = excluded.generated_at,
            updated_at = now()
        `;
      } catch (err) {
        throw explain(err);
      }
    },

    async latestPerSymbol(): Promise<SignalRow[]> {
      try {
        const rows = (await sql`
          select symbol, payload, generated_at from latest_signal
        `) as unknown as Array<{ symbol: string; payload: TradeSignal; generated_at: string }>;
        // `payload` already is the signal; the id/created_at a SignalRow
        // carries are history-table concepts this table has no equivalent of.
        return rows.map((r) => ({
          ...(r.payload as TradeSignal),
          id: r.symbol,
          created_at: r.generated_at,
        })) as SignalRow[];
      } catch (err) {
        throw explain(err);
      }
    },

    async insertJournalEntry(
      entry: JournalEntryInput,
      severity: number | null,
    ): Promise<JournalEntry> {
      try {
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
      } catch (err) {
        throw explain(err);
      }
    },

    async listJournal(options: {
      symbol?: string | null;
      limit: number;
    }): Promise<JournalEntry[]> {
      try {
        const rows = await sql`
        select * from trade_journal
        where (${options.symbol ?? null}::text is null or symbol = ${options.symbol ?? null})
        order by closed_at desc
        limit ${options.limit}
      `;
        return rows as unknown as JournalEntry[];
      } catch (err) {
        throw explain(err);
      }
    },

    async getMonitorState(symbol: string): Promise<MonitorRow | null> {
      try {
        const rows = (await sql`
          select * from plan_monitor where symbol = ${symbol}
        `) as unknown as Array<{
          symbol: string;
          signal_id: string | null;
          state: string;
          add_ons_filled: number;
          active_stop: number | null;
          last_price: number | null;
          tracked?: MonitorRow["tracked"];
        }>;
        const row = rows[0];
        if (!row) return null;
        return {
          symbol: row.symbol,
          signalId: row.signal_id,
          state: row.state as PlanState,
          addOnsFilled: row.add_ons_filled,
          activeStop: row.active_stop,
          lastPrice: row.last_price,
          tracked: row.tracked ?? null,
        };
      } catch (err) {
        throw explain(err);
      }
    },

    async saveMonitorState(row: MonitorRow): Promise<void> {
      // Upsert: one row per symbol, always describing the newest plan.
      const upsert = () => sql`
        insert into plan_monitor (symbol, signal_id, state, add_ons_filled, active_stop, last_price, tracked, updated_at)
        values (${row.symbol}, ${row.signalId}, ${row.state}, ${row.addOnsFilled},
                ${row.activeStop}, ${row.lastPrice},
                ${row.tracked ? JSON.stringify(row.tracked) : null}, now())
        on conflict (symbol) do update set
          signal_id = excluded.signal_id,
          state = excluded.state,
          add_ons_filled = excluded.add_ons_filled,
          active_stop = excluded.active_stop,
          last_price = excluded.last_price,
          tracked = excluded.tracked,
          updated_at = now()
      `;
      try {
        await upsert();
      } catch (err) {
        // Self-healing migration. `tracked` shipped after the table did, and
        // /api/setup locks itself once the tables exist (its bootstrap rule
        // predates column migrations) — so a deployment that never re-runs the
        // schema would crash the monitor on every sweep forever. DATABASE_URL
        // owns its schema; adding the column here is the same idempotent
        // statement schema.sql carries.
        const message = err instanceof Error ? err.message : String(err);
        if (/tracked/.test(message) && /column|欄位/i.test(message)) {
          try {
            await sql`alter table public.plan_monitor add column if not exists tracked jsonb`;
            await upsert();
            return;
          } catch (retryErr) {
            throw explain(retryErr);
          }
        }
        throw explain(err);
      }
    },

    async recordRelease(row: ReleaseRow): Promise<{ isNew: boolean }> {
      try {
        // `on conflict do nothing` + `returning` is what makes this atomic:
        // the row comes back only when this statement was the one that
        // inserted it, so two concurrent callers can't both see a new print.
        // An estimate arriving later (calendar lagging FRED) is allowed to
        // fill in, but never to overwrite one already stored.
        const rows = (await sql`
          insert into data_release (series_id, period, value, previous_value, estimate)
          values (${row.seriesId}, ${row.period}, ${row.value}, ${row.previousValue}, ${row.estimate})
          on conflict (series_id, period) do nothing
          returning series_id
        `) as unknown as Array<{ series_id: string }>;

        if (rows.length === 0 && row.estimate !== null) {
          await sql`
            update data_release set estimate = ${row.estimate}
            where series_id = ${row.seriesId} and period = ${row.period} and estimate is null
          `;
        }
        return { isNew: rows.length > 0 };
      } catch (err) {
        throw explain(err);
      }
    },

    async recentReleases(hours: number): Promise<StoredRelease[]> {
      try {
        const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
        const rows = (await sql`
          select series_id, period, value, previous_value, estimate, first_seen_at
          from data_release
          where first_seen_at >= ${cutoff}
          order by first_seen_at desc
        `) as unknown as Array<{
          series_id: string;
          period: string;
          value: number;
          previous_value: number | null;
          estimate: number | null;
          first_seen_at: string;
        }>;
        return rows.map((r) => ({
          seriesId: r.series_id,
          period: r.period,
          value: r.value,
          previousValue: r.previous_value,
          estimate: r.estimate,
          firstSeenAt: new Date(r.first_seen_at).toISOString(),
        }));
      } catch (err) {
        throw explain(err);
      }
    },

    async readCache(key: string): Promise<{ payload: unknown; fetchedAt: string } | null> {
      try {
        const rows = (await sql`
          select payload, fetched_at from source_cache where cache_key = ${key}
        `) as unknown as Array<{ payload: unknown; fetched_at: string }>;
        const row = rows[0];
        return row ? { payload: row.payload, fetchedAt: new Date(row.fetched_at).toISOString() } : null;
      } catch (err) {
        throw explain(err);
      }
    },

    async writeCache(key: string, payload: unknown): Promise<void> {
      try {
        await sql`
          insert into source_cache (cache_key, payload, fetched_at)
          values (${key}, ${JSON.stringify(payload)}, now())
          on conflict (cache_key) do update set
            payload = excluded.payload, fetched_at = now()
        `;
      } catch (err) {
        throw explain(err);
      }
    },

    async listSettings(): Promise<Map<string, string>> {
      try {
        const rows = (await sql`select key, value from app_settings`) as unknown as Array<{
          key: string;
          value: string;
        }>;
        return new Map(rows.map((r) => [r.key, r.value]));
      } catch (err) {
        throw explain(err);
      }
    },

    async saveSetting(key: string, value: string): Promise<void> {
      try {
        await sql`
          insert into app_settings (key, value, updated_at)
          values (${key}, ${value}, now())
          on conflict (key) do update set value = excluded.value, updated_at = now()
        `;
      } catch (err) {
        throw explain(err);
      }
    },
  };
}

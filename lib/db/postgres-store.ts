import { neon } from "@neondatabase/serverless";
import type { SignalRow, TradeSignal } from "@/types/signal";
import type { JournalEntry, JournalEntryInput } from "@/types/journal";
import type {
  HistoryFilter,
  LabTradeFilter,
  LabTradeRow,
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
  // Checked before the relation case, because Postgres phrases a missing
  // column as `column "x" of relation "y" does not exist` — which *contains*
  // `relation "y" does not exist`, and the relation branch was rewriting a
  // schema-drift error into "the tables don't exist". The user, whose tables
  // very much existed, was then sent in a loop between a page telling them to
  // create tables and a setup call telling them the tables were already there.
  if (/column ".*".* does not exist/i.test(message)) {
    return new Error(
      `資料表結構過舊（缺少新欄位）—— 到 /setup 按一次「建立資料表」即可補上，不會動到既有資料。原始錯誤：${message}`,
    );
  }
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
  // `cache: "no-store"` is load-bearing, not hygiene. The driver issues every
  // query as a fetch() POST, and on Vercel the platform's Data Cache — which
  // persists ACROSS deployments — was capturing those responses. Writes carry
  // unique parameters, so their requests never hit the cache and always
  // reached the database; reads are byte-identical SQL every time, so after
  // one execution they were replayed from cache forever. That asymmetry
  // produced two days of "impossible" behaviour: INSERTs committing with
  // RETURNING receipts while the very next SELECT saw a world frozen at the
  // moment the cache entry was first filled — surviving redeploys, pooler
  // bypasses and read-back retries alike. The smoking gun: nine separate
  // scans quoting a database self-description identical to the microsecond.
  const sql = neon(connectionString, { fetchOptions: { cache: "no-store" } });

  return {
    kind: "postgres",

    async insertSignal(signal: TradeSignal): Promise<void> {
      try {
        // Parameterised throughout — every value here is interpolated by the
        // driver, never concatenated into the statement.
        //
        // `returning id` is the receipt. A day of sweeps "succeeded" while
        // nothing became readable, and a bare INSERT's success only proves
        // the statement ran — RETURNING proves a row exists in the database
        // that ran it. An empty return means something inside the database
        // (a rule, a trigger, an interceptor) discarded the row, which is a
        // storage failure and must throw, not report success.
        const rows = (await sql`
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
        returning id
      `) as unknown as Array<{ id: string }>;
        if (rows.length === 0) {
          throw new Error(
            "insert 被資料庫吞掉：陳述式執行成功但沒有建立任何列（RETURNING 為空）",
          );
        }
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
        // Same receipt as insertSignal: an upsert that neither inserted nor
        // updated returned no row, and that is a discard, not a success.
        const rows = (await sql`
          insert into latest_signal (symbol, payload, generated_at, updated_at)
          values (${signal.symbol}, ${JSON.stringify(signal)}, ${signal.generated_at}, now())
          on conflict (symbol) do update set
            payload = excluded.payload,
            generated_at = excluded.generated_at,
            updated_at = now()
          returning symbol
        `) as unknown as Array<{ symbol: string }>;
        if (rows.length === 0) {
          throw new Error(
            "upsert 被資料庫吞掉：陳述式執行成功但沒有寫入任何列（RETURNING 為空）",
          );
        }
      } catch (err) {
        throw explain(err);
      }
    },

    async prune(): Promise<{ signals: number; cache: number }> {
      try {
        // `returning` so the counts are real, not guessed. Interval literals,
        // not JS dates: the database's clock decides, the same clock that
        // stamped the rows.
        const oldSignals = (await sql`
          delete from signals where generated_at < now() - interval '14 days' returning id
        `) as unknown as unknown[];
        const oldCache = (await sql`
          delete from source_cache where fetched_at < now() - interval '7 days' returning cache_key
        `) as unknown as unknown[];
        return { signals: oldSignals.length, cache: oldCache.length };
      } catch (err) {
        throw explain(err);
      }
    },

    async snapshot(): Promise<Record<string, unknown>> {
      const rows = (await sql`
        select current_database() as db, current_user as role, now()::text as db_now,
               (select count(*)::int from signals) as signal_rows,
               (select max(generated_at)::text from signals) as newest_signal,
               (select count(*)::int from latest_signal) as latest_rows
      `) as unknown as Array<Record<string, unknown>>;
      return rows[0] ?? {};
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

    async insertLabTrades(rows: LabTradeRow[]): Promise<number> {
      if (rows.length === 0) return 0;
      try {
        let inserted = 0;
        // One statement per row: Neon's HTTP driver executes one statement per
        // request, and the batch is at most 12 conditions × 2 directions on the
        // one sweep that sees a new daily bar. `do nothing` is what makes a
        // repeated advance on the same bar cost nothing instead of duplicating.
        for (const r of rows) {
          const returned = (await sql`
            insert into lab_forward (
              id, symbol, direction, condition_id, entry_bar_time, entry, stop, target,
              atr, horizon_bars, status, opened_at
            ) values (
              ${r.id}, ${r.symbol}, ${r.direction}, ${r.conditionId}, ${r.entryBarTime},
              ${r.entry}, ${r.stop}, ${r.target}, ${r.atr}, ${r.horizonBars}, ${r.status},
              ${r.openedAt}
            )
            on conflict (id) do nothing
            returning id
          `) as unknown as unknown[];
          inserted += returned.length;
        }
        return inserted;
      } catch (err) {
        throw explain(err);
      }
    },

    async listLabTrades(filter: LabTradeFilter): Promise<LabTradeRow[]> {
      try {
        const rows = (await sql`
          select * from lab_forward
          where (${filter.symbol ?? null}::text is null or symbol = ${filter.symbol ?? null})
            and (${filter.direction ?? null}::text is null or direction = ${filter.direction ?? null})
            and (${filter.status ?? null}::text is null or status = ${filter.status ?? null})
          order by entry_bar_time desc
          limit ${filter.limit}
        `) as unknown as Array<Record<string, unknown>>;
        return rows.map(toLabTrade);
      } catch (err) {
        throw explain(err);
      }
    },

    async resolveLabTrades(rows: LabTradeRow[]): Promise<number> {
      if (rows.length === 0) return 0;
      try {
        let updated = 0;
        for (const r of rows) {
          // `status = 'open'` in the predicate, not just the id: two sweeps
          // racing on the same resolution must produce one write, and the
          // second must know it lost rather than overwrite the first.
          const returned = (await sql`
            update lab_forward set
              status = ${r.status},
              exit_price = ${r.exitPrice},
              exit_bar_time = ${r.exitBarTime},
              bars_held = ${r.barsHeld},
              closed_at = ${r.closedAt ?? new Date().toISOString()}
            where id = ${r.id} and status = 'open'
            returning id
          `) as unknown as unknown[];
          updated += returned.length;
        }
        return updated;
      } catch (err) {
        throw explain(err);
      }
    },
  };
}

/** Postgres columns are snake_case; the row type is not. */
function toLabTrade(r: Record<string, unknown>): LabTradeRow {
  const iso = (v: unknown): string | null =>
    v === null || v === undefined ? null : new Date(v as string).toISOString();
  return {
    id: String(r.id),
    symbol: String(r.symbol),
    direction: r.direction === "short" ? "short" : "long",
    conditionId: String(r.condition_id),
    entryBarTime: iso(r.entry_bar_time)!,
    entry: Number(r.entry),
    stop: Number(r.stop),
    target: r.target === null || r.target === undefined ? null : Number(r.target),
    atr: Number(r.atr),
    horizonBars: Number(r.horizon_bars),
    status: r.status as LabTradeRow["status"],
    exitPrice: r.exit_price === null || r.exit_price === undefined ? null : Number(r.exit_price),
    exitBarTime: iso(r.exit_bar_time),
    barsHeld: r.bars_held === null || r.bars_held === undefined ? null : Number(r.bars_held),
    openedAt: iso(r.opened_at) ?? new Date(0).toISOString(),
    closedAt: iso(r.closed_at),
  };
}

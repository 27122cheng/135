import { createClient, type SupabaseClient } from "@supabase/supabase-js";
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
 * Supabase backend — the default when DATABASE_URL is unset.
 *
 * Two clients rather than one: writes need the service-role key (RLS blocks
 * anonymous inserts on `signals`), reads use the anon key so the history page
 * works without ever handing a privileged key to a public route.
 */

let serverClient: SupabaseClient | null | undefined;
let anonClient: SupabaseClient | null | undefined;

/** Service-role client — required to write to `signals`. */
export function getSupabaseServerClient(): SupabaseClient | null {
  if (serverClient !== undefined) return serverClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  serverClient = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  return serverClient;
}

/** Read-only anon client — safe for the public history page. */
export function getSupabaseAnonClient(): SupabaseClient | null {
  if (anonClient !== undefined) return anonClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  anonClient = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  return anonClient;
}

export function supabaseStore(): SignalStore | null {
  // Either key alone is enough to be "configured" — a deployment that only
  // reads history needs no service-role key, and the cron job that only writes
  // needs no anon key. The individual methods report which one is missing.
  if (!getSupabaseServerClient() && !getSupabaseAnonClient()) return null;

  return {
    kind: "supabase",

    async insertSignal(signal: TradeSignal): Promise<void> {
      const client = getSupabaseServerClient();
      if (!client) throw new Error("缺少 SUPABASE_SERVICE_ROLE_KEY，無法寫入 signals");
      const { error } = await client.from("signals").insert({
        symbol: signal.symbol,
        direction: signal.direction,
        grade: signal.grade,
        bias_score: signal.bias_score,
        entry_structure_score: signal.entry_structure_score,
        total_score: signal.total_score,
        entry_zone: signal.entry_zone,
        stop_loss: signal.stop_loss,
        take_profits: signal.take_profits,
        bias_items: signal.bias_items,
        entry_structures: signal.entry_structures,
        path_obstacles: signal.path_obstacles,
        narrative: signal.narrative,
        trade_plan: signal.trade_plan,
        plan_backtest: signal.plan_backtest,
        data_gaps: signal.data_gaps,
        generated_at: signal.generated_at,
      });
      if (error) throw new Error(error.message);
    },

    async prune(): Promise<{ signals: number; cache: number }> {
      const client = getSupabaseServerClient();
      if (!client) throw new Error("缺少 SUPABASE_SERVICE_ROLE_KEY，無法清理舊資料");
      const signalCutoff = new Date(Date.now() - 14 * 24 * 3600_000).toISOString();
      const cacheCutoff = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
      const a = await client
        .from("signals")
        .delete({ count: "exact" })
        .lt("generated_at", signalCutoff);
      if (a.error) throw new Error(a.error.message);
      const b = await client
        .from("source_cache")
        .delete({ count: "exact" })
        .lt("fetched_at", cacheCutoff);
      if (b.error) throw new Error(b.error.message);
      return { signals: a.count ?? 0, cache: b.count ?? 0 };
    },

    async listSignals(filter: HistoryFilter): Promise<SignalRow[]> {
      const client = getSupabaseAnonClient();
      if (!client) throw new Error("缺少 NEXT_PUBLIC_SUPABASE_ANON_KEY，無法讀取 signals");
      let query = client
        .from("signals")
        .select("*")
        .order("generated_at", { ascending: false })
        .limit(filter.limit);
      if (filter.symbol) query = query.eq("symbol", filter.symbol);
      if (filter.grade) query = query.eq("grade", filter.grade);
      if (filter.stance) query = query.eq("trade_plan->>stance", filter.stance);
      if (filter.from) query = query.gte("generated_at", filter.from);
      if (filter.to) query = query.lte("generated_at", filter.to);

      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return (data ?? []) as SignalRow[];
    },

    async saveLatest(signal: TradeSignal): Promise<void> {
      const client = getSupabaseServerClient();
      if (!client) throw new Error("缺少 SUPABASE_SERVICE_ROLE_KEY，無法寫入 latest_signal");
      const { error } = await client.from("latest_signal").upsert(
        {
          symbol: signal.symbol,
          payload: signal,
          generated_at: signal.generated_at,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "symbol" },
      );
      if (error) throw new Error(error.message);
    },

    async latestPerSymbol(): Promise<SignalRow[]> {
      const client = getSupabaseAnonClient() ?? getSupabaseServerClient();
      if (!client) throw new Error("缺少 Supabase 金鑰，無法讀取 latest_signal");
      const { data, error } = await client
        .from("latest_signal")
        .select("symbol, payload, generated_at");
      if (error) throw new Error(error.message);
      return (data ?? []).map((r: Record<string, unknown>) => ({
        ...(r.payload as TradeSignal),
        id: r.symbol as string,
        created_at: r.generated_at as string,
      })) as SignalRow[];
    },

    async insertJournalEntry(
      entry: JournalEntryInput,
      severity: number | null,
    ): Promise<JournalEntry> {
      const client = getSupabaseServerClient();
      if (!client) throw new Error("缺少 SUPABASE_SERVICE_ROLE_KEY，無法寫入 trade_journal");
      const { data, error } = await client
        .from("trade_journal")
        .insert({ ...entry, severity })
        .select()
        .single();
      if (error) throw new Error(error.message);
      return data as JournalEntry;
    },

    async listJournal(options: { symbol?: string | null; limit: number }): Promise<JournalEntry[]> {
      // Reads go through the anon client where possible so the public /review
      // page never needs the service-role key; falls back to the server client
      // for a write-only deployment.
      const client = getSupabaseAnonClient() ?? getSupabaseServerClient();
      if (!client) throw new Error("缺少 Supabase 金鑰，無法讀取 trade_journal");
      let query = client
        .from("trade_journal")
        .select("*")
        .order("closed_at", { ascending: false })
        .limit(options.limit);
      if (options.symbol) query = query.eq("symbol", options.symbol);

      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return (data ?? []) as JournalEntry[];
    },

    async getMonitorState(symbol: string): Promise<MonitorRow | null> {
      const client = getSupabaseAnonClient() ?? getSupabaseServerClient();
      if (!client) throw new Error("缺少 Supabase 金鑰，無法讀取 plan_monitor");
      const { data, error } = await client
        .from("plan_monitor")
        .select("*")
        .eq("symbol", symbol)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      return {
        symbol: data.symbol,
        signalId: data.signal_id,
        state: data.state as PlanState,
        addOnsFilled: data.add_ons_filled,
        activeStop: data.active_stop,
        lastPrice: data.last_price,
        tracked: data.tracked ?? null,
      };
    },

    async saveMonitorState(row: MonitorRow): Promise<void> {
      const client = getSupabaseServerClient();
      if (!client) throw new Error("缺少 SUPABASE_SERVICE_ROLE_KEY，無法寫入 plan_monitor");
      const payload = {
        symbol: row.symbol,
        signal_id: row.signalId,
        state: row.state,
        add_ons_filled: row.addOnsFilled,
        active_stop: row.activeStop,
        last_price: row.lastPrice,
        tracked: row.tracked ?? null,
        updated_at: new Date().toISOString(),
      };
      const { error } = await client.from("plan_monitor").upsert(payload, { onConflict: "symbol" });
      if (error) {
        // PostgREST can't run DDL, so a project that hasn't re-run
        // supabase/schema.sql since the `tracked` column landed would crash
        // the monitor on every sweep. Degrade instead: save the state without
        // the snapshot (sticky tracking off until the schema is updated) —
        // a monitor with short memory beats a monitor that's down.
        if (/tracked/.test(error.message)) {
          const { tracked: _omitted, ...withoutTracked } = payload;
          void _omitted;
          const retry = await client
            .from("plan_monitor")
            .upsert(withoutTracked, { onConflict: "symbol" });
          if (!retry.error) return;
        }
        throw new Error(error.message);
      }
    },

    async recordRelease(row: ReleaseRow): Promise<{ isNew: boolean }> {
      const client = getSupabaseServerClient();
      if (!client) throw new Error("缺少 SUPABASE_SERVICE_ROLE_KEY，無法寫入 data_release");
      // PostgREST returns the inserted rows only when the insert actually
      // happened, so `ignoreDuplicates` gives the same atomic "was it new"
      // answer as the Postgres path — no read-then-write race between the
      // 4-hour refresh and the 5-minute monitor.
      const { data, error } = await client
        .from("data_release")
        .upsert(
          {
            series_id: row.seriesId,
            period: row.period,
            value: row.value,
            previous_value: row.previousValue,
            estimate: row.estimate,
          },
          { onConflict: "series_id,period", ignoreDuplicates: true },
        )
        .select("series_id");
      if (error) throw new Error(error.message);

      const isNew = (data?.length ?? 0) > 0;
      if (!isNew && row.estimate !== null) {
        await client
          .from("data_release")
          .update({ estimate: row.estimate })
          .eq("series_id", row.seriesId)
          .eq("period", row.period)
          .is("estimate", null);
      }
      return { isNew };
    },

    async recentReleases(hours: number): Promise<StoredRelease[]> {
      const client = getSupabaseAnonClient() ?? getSupabaseServerClient();
      if (!client) throw new Error("缺少 Supabase 金鑰，無法讀取 data_release");
      const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
      const { data, error } = await client
        .from("data_release")
        .select("series_id, period, value, previous_value, estimate, first_seen_at")
        .gte("first_seen_at", cutoff)
        .order("first_seen_at", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []).map((r: Record<string, unknown>) => ({
        seriesId: r.series_id as string,
        period: r.period as string,
        value: r.value as number,
        previousValue: r.previous_value as number | null,
        estimate: r.estimate as number | null,
        firstSeenAt: new Date(r.first_seen_at as string).toISOString(),
      }));
    },

    async readCache(key: string): Promise<{ payload: unknown; fetchedAt: string } | null> {
      const client = getSupabaseServerClient() ?? getSupabaseAnonClient();
      if (!client) throw new Error("缺少 Supabase 金鑰，無法讀取 source_cache");
      const { data, error } = await client
        .from("source_cache")
        .select("payload, fetched_at")
        .eq("cache_key", key)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      return {
        payload: data.payload,
        fetchedAt: new Date(data.fetched_at as string).toISOString(),
      };
    },

    async writeCache(key: string, payload: unknown): Promise<void> {
      const client = getSupabaseServerClient();
      if (!client) throw new Error("缺少 SUPABASE_SERVICE_ROLE_KEY，無法寫入 source_cache");
      const { error } = await client
        .from("source_cache")
        .upsert({ cache_key: key, payload, fetched_at: new Date().toISOString() },
          { onConflict: "cache_key" });
      if (error) throw new Error(error.message);
    },

    async listSettings(): Promise<Map<string, string>> {
      // Service-role only: `app_settings` deliberately has no public read
      // policy, so the anon client would silently come back empty and the
      // deployment would look unconfigured while holding a valid token.
      const client = getSupabaseServerClient();
      if (!client) throw new Error("缺少 SUPABASE_SERVICE_ROLE_KEY，無法讀取 app_settings");
      const { data, error } = await client.from("app_settings").select("key, value");
      if (error) throw new Error(error.message);
      return new Map((data ?? []).map((r) => [r.key as string, r.value as string]));
    },

    async saveSetting(key: string, value: string): Promise<void> {
      const client = getSupabaseServerClient();
      if (!client) throw new Error("缺少 SUPABASE_SERVICE_ROLE_KEY，無法寫入 app_settings");
      const { error } = await client
        .from("app_settings")
        .upsert(
          { key, value, updated_at: new Date().toISOString() },
          { onConflict: "key" },
        );
      if (error) throw new Error(error.message);
    },

    async insertLabTrades(rows: LabTradeRow[]): Promise<number> {
      if (rows.length === 0) return 0;
      const client = getSupabaseServerClient();
      if (!client) throw new Error("缺少 SUPABASE_SERVICE_ROLE_KEY，無法寫入 lab_forward");
      // ignoreDuplicates is what makes a repeated advance on the same bar a
      // no-op — the id is derived from the entry bar for exactly that reason.
      const { data, error } = await client
        .from("lab_forward")
        .upsert(rows.map(fromLabTrade), { onConflict: "id", ignoreDuplicates: true })
        .select("id");
      if (error) throw new Error(error.message);
      return (data ?? []).length;
    },

    async listLabTrades(filter: LabTradeFilter): Promise<LabTradeRow[]> {
      const client = getSupabaseAnonClient() ?? getSupabaseServerClient();
      if (!client) throw new Error("缺少 Supabase 金鑰，無法讀取 lab_forward");
      let query = client
        .from("lab_forward")
        .select("*")
        .order("entry_bar_time", { ascending: false })
        .limit(filter.limit);
      if (filter.symbol) query = query.eq("symbol", filter.symbol);
      if (filter.direction) query = query.eq("direction", filter.direction);
      if (filter.status) query = query.eq("status", filter.status);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return (data ?? []).map(toLabTrade);
    },

    async resolveLabTrades(rows: LabTradeRow[]): Promise<number> {
      if (rows.length === 0) return 0;
      const client = getSupabaseServerClient();
      if (!client) throw new Error("缺少 SUPABASE_SERVICE_ROLE_KEY，無法更新 lab_forward");
      let updated = 0;
      for (const r of rows) {
        // Matching on status too: two sweeps racing on one resolution must
        // produce a single write, and the loser must not overwrite the winner.
        const { data, error } = await client
          .from("lab_forward")
          .update({
            status: r.status,
            exit_price: r.exitPrice,
            exit_bar_time: r.exitBarTime,
            bars_held: r.barsHeld,
            closed_at: r.closedAt ?? new Date().toISOString(),
          })
          .eq("id", r.id)
          .eq("status", "open")
          .select("id");
        if (error) throw new Error(error.message);
        updated += (data ?? []).length;
      }
      return updated;
    },
  };
}

/** The table is snake_case; the row type is not. */
function fromLabTrade(r: LabTradeRow): Record<string, unknown> {
  return {
    id: r.id,
    symbol: r.symbol,
    direction: r.direction,
    condition_id: r.conditionId,
    entry_bar_time: r.entryBarTime,
    entry: r.entry,
    stop: r.stop,
    target: r.target,
    atr: r.atr,
    horizon_bars: r.horizonBars,
    status: r.status,
    opened_at: r.openedAt,
  };
}

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
    target: Number(r.target),
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

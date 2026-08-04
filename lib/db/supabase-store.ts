import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { SignalRow, TradeSignal } from "@/types/signal";
import type { JournalEntry, JournalEntryInput } from "@/types/journal";
import type { HistoryFilter, SignalStore } from "./index";

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
      if (filter.from) query = query.gte("generated_at", filter.from);
      if (filter.to) query = query.lte("generated_at", filter.to);

      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return (data ?? []) as SignalRow[];
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
  };
}

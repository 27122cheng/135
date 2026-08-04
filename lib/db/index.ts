import type { SignalRow, TradeSignal } from "@/types/signal";
import type { JournalEntry, JournalEntryInput } from "@/types/journal";
import { supabaseStore } from "./supabase-store";
import { postgresStore } from "./postgres-store";

/**
 * Storage behind one interface so the database is a deployment choice, not a
 * code dependency.
 *
 * Selection is exactly as specified: set `DATABASE_URL` and the app talks
 * plain Postgres (Neon's free tier, or any Postgres), leave it unset and it
 * uses Supabase. Nothing else switches — no build flag, no code edit.
 *
 * Both backends read and write the same `signals` table defined in
 * supabase/schema.sql; the file is plain SQL and applies to either.
 */

export interface HistoryFilter {
  symbol?: string | null;
  grade?: string | null;
  from?: string | null;
  to?: string | null;
  limit: number;
}

export interface SignalStore {
  readonly kind: "postgres" | "supabase";
  /** Append-only: /history shows the timeline, so rows are never updated in place. */
  insertSignal(signal: TradeSignal): Promise<void>;
  listSignals(filter: HistoryFilter): Promise<SignalRow[]>;

  /** `severity` is computed server-side, so it is passed separately from the input. */
  insertJournalEntry(entry: JournalEntryInput, severity: number | null): Promise<JournalEntry>;
  /**
   * Newest first. `symbol` scopes the intervention lookback to the instrument
   * being analysed — a run of bad EURUSD entries shouldn't tighten gold.
   */
  listJournal(options: { symbol?: string | null; limit: number }): Promise<JournalEntry[]>;
}

/** Null when neither backend is configured — callers must return 501, not crash. */
export function getSignalStore(): SignalStore | null {
  if (process.env.DATABASE_URL?.trim()) return postgresStore(process.env.DATABASE_URL.trim());
  return supabaseStore();
}

/** Which backend is active, for /api/diagnostics. Never exposes the connection string. */
export function storeKind(): string {
  return getSignalStore()?.kind ?? "none";
}

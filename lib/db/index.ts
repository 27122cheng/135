import type { SignalRow, TradeSignal } from "@/types/signal";
import type { JournalEntry, JournalEntryInput } from "@/types/journal";
import type { MonitorMemory } from "@/lib/monitor/plan-state";
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

  /** Last reported monitor state for a symbol; null before the first run. */
  getMonitorState(symbol: string): Promise<MonitorRow | null>;
  saveMonitorState(row: MonitorRow): Promise<void>;

  /**
   * Records a macro observation the first time it is seen, and reports whether
   * this call was that first time.
   *
   * The "was it new" answer has to come from the insert itself rather than a
   * read followed by a write: the 4-hour refresh and the 5-minute monitor both
   * call this, and a check-then-insert would let both decide the same CPI print
   * was new and announce it twice.
   */
  recordRelease(row: ReleaseRow): Promise<{ isNew: boolean }>;
  /** Releases first seen within the last `hours`, newest first. */
  recentReleases(hours: number): Promise<StoredRelease[]>;

  /**
   * Every stored setting. Read as a whole rather than one key at a time
   * because the caller needs several per invocation and this is a network hop.
   * Callers must treat a throw as "no settings yet" — see lib/settings.ts.
   */
  listSettings(): Promise<Map<string, string>>;
  saveSetting(key: string, value: string): Promise<void>;
}

/** One row of `data_release` — a single macro print. */
export interface ReleaseRow {
  seriesId: string;
  /** The observation's own period label, e.g. "2026-07-01". */
  period: string;
  value: number;
  previousValue: number | null;
  /** Market consensus if a calendar supplied one; null means compare to previous. */
  estimate: number | null;
}

export interface StoredRelease extends ReleaseRow {
  firstSeenAt: string;
}

/** One row of `plan_monitor` — what was last reported, so it isn't repeated. */
export interface MonitorRow extends MonitorMemory {
  symbol: string;
  signalId: string | null;
  lastPrice: number | null;
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

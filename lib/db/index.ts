import type { Grade, SignalRow, TradePlan, TradeSignal } from "@/types/signal";
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
  /**
   * "enter" narrows to rows whose plan actually recommended a trade.
   *
   * A database predicate, not a client-side filter, because the difference is
   * the whole bug it fixes: /history fetched the newest 50 rows and filtered
   * them in the browser, and once the auto-scan was appending dozens of 觀望
   * rows a day, every enter row had been pushed past row 50 — so the page said
   * "這段期間的掃描全部是觀望" forever while Telegram kept announcing trades
   * that were sitting in the same table, fifty rows down.
   */
  stance?: "enter" | null;
  limit: number;
}

export interface SignalStore {
  readonly kind: "postgres" | "supabase";
  /** Append-only: /history shows the timeline, so rows are never updated in place. */
  insertSignal(signal: TradeSignal): Promise<void>;
  listSignals(filter: HistoryFilter): Promise<SignalRow[]>;

  /**
   * One-line self-identification for forensics: which database, which role,
   * what time it thinks it is, how many signal rows it holds and the newest
   * generated_at. Optional — only the postgres store implements it — and only
   * read when a write has just failed to round-trip, so the failure report can
   * quote the database's own account of itself instead of guessing.
   */
  snapshot?(): Promise<Record<string, unknown>>;

  /**
   * Deletes what the free tier cannot afford to keep: signal rows older than
   * two weeks and cache rows older than one. Nine symbols writing hourly is
   * a few hundred rows a day, each carrying full bias items and a narrative
   * — enough to walk a 0.5GB Neon allowance into a wall in weeks, and a full
   * database fails writes, which this project has already spent days
   * diagnosing once. The journal is deliberately untouched: resolved trades
   * are the track record, and the track record is forever. `lab_forward` is
   * untouched for the same reason — a forward test that deletes its own oldest
   * results is not a forward test — and it stays small by construction: one
   * open trade per condition and direction, a few thousand rows a year.
   */
  prune?(): Promise<{ signals: number; cache: number }>;

  /**
   * Upserts the signal currently in force for a symbol.
   *
   * Separate from `insertSignal` on purpose. That one appends to the history
   * timeline; this one replaces. A dashboard rescanning nine symbols every five
   * minutes would otherwise write ~2,600 history rows a day, each carrying the
   * full bias items and narrative — enough to fill a free-tier database in
   * about three weeks and bury the real history under it.
   */
  saveLatest(signal: TradeSignal): Promise<void>;

  /**
   * The newest stored signal for each symbol, in one round trip.
   *
   * The board needs all nine at once. Doing that as nine `listSignals(limit:1)`
   * calls is nine network hops on a serverless request, and building them live
   * is nine full pipelines — which is exactly the wait this replaces. The
   * scheduled refresh has already done the work; this just reads it.
   */
  latestPerSymbol(): Promise<SignalRow[]>;

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

  /**
   * The cross-invocation half of the source cache.
   *
   * The in-memory cache is per-process, and on Vercel a process serves one
   * request and may never be reused — which made fetchFree's "serve the last
   * good answer, labelled stale" tier unreachable in practice. Every miss went
   * straight to 取得失敗，且無可用快取, so a source being down for one minute
   * became a hole in the analysis instead of a slightly old number.
   */
  readCache(key: string): Promise<{ payload: unknown; fetchedAt: string } | null>;
  writeCache(key: string, payload: unknown): Promise<void>;

  /**
   * 實驗室前進測試 — the paper trades each condition is running live.
   *
   * `insertLabTrades` must be a no-op for an id that already exists: the
   * advance runs on every sweep and the id is derived from the entry bar, so
   * the second sweep of the same day must not open the trade again.
   */
  insertLabTrades(rows: LabTradeRow[]): Promise<number>;
  listLabTrades(filter: LabTradeFilter): Promise<LabTradeRow[]>;
  /** Writes the resolution of trades that reached their stop, target or horizon. */
  resolveLabTrades(rows: LabTradeRow[]): Promise<number>;
}

export type LabTradeStatus = "open" | "win" | "loss" | "expired";

/** One paper trade taken by one condition, on its own, in the forward test. */
export interface LabTradeRow {
  /** symbol:direction:condition:entryBarTime — deterministic, hence idempotent. */
  id: string;
  symbol: string;
  direction: "long" | "short";
  conditionId: string;
  entryBarTime: string;
  entry: number;
  stop: number;
  /** Null when no overhead pressure existed at entry — managed by the stop alone. */
  target: number | null;
  atr: number;
  horizonBars: number;
  status: LabTradeStatus;
  exitPrice: number | null;
  exitBarTime: string | null;
  barsHeld: number | null;
  openedAt: string;
  closedAt: string | null;
}

export interface LabTradeFilter {
  symbol?: string | null;
  direction?: "long" | "short" | null;
  /** "open" narrows to unresolved trades — what the advance needs. */
  status?: LabTradeStatus | null;
  limit: number;
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

/**
 * Snapshot of the plan the monitor is holding a position against.
 *
 * Stored in `plan_monitor` itself because nothing else can identify it: the
 * board's rows come from `latest_signal`, whose `id` is just the symbol, and
 * every rescan replaces the payload. Without this snapshot a new scan reset
 * the tracker mid-flight — the same entry re-fired on every sweep and no
 * trade ever reached its stop or target, so the journal stayed empty.
 */
export interface TrackedPlan {
  direction: "long" | "short";
  grade: Grade;
  plan: TradePlan;
  /** Identity of the scan that produced the plan (ids are not stable). */
  generatedAt: string;
}

/** One row of `plan_monitor` — what was last reported, so it isn't repeated. */
export interface MonitorRow extends MonitorMemory {
  symbol: string;
  signalId: string | null;
  lastPrice: number | null;
  /** Null on rows written before snapshotting existed. */
  tracked?: TrackedPlan | null;
}

/**
 * Routes around Neon's pooler for the HTTP driver.
 *
 * The live deployment's DATABASE_URL points at an `ep-…-pooler` host, and
 * through it this app spent a day in an impossible state: INSERTs accepted
 * and committed, immediate SELECTs — same connection string, same invocation
 * — coming back without the rows, the whole read side frozen at one moment
 * in time. Every Neon pooler host has a direct twin at the same hostname
 * minus the `-pooler` suffix, same credentials, same database; and Neon's
 * own guidance for the HTTP fetch driver is to use the direct endpoint — the
 * driver brokers per-request connections server-side, so PgBouncer adds
 * nothing here except, evidently, a place for reads and writes to part ways.
 *
 * Only the Neon convention is rewritten (first label ending in `-pooler` on
 * a `.neon.tech` host). Anything else — Supabase's pooler, self-hosted
 * Postgres — passes through untouched.
 */
export function directNeonUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith(".neon.tech")) {
      const [first, ...rest] = u.hostname.split(".");
      if (first.endsWith("-pooler")) {
        u.hostname = [first.slice(0, -"-pooler".length), ...rest].join(".");
        return u.toString();
      }
    }
    return url;
  } catch {
    return url;
  }
}

/** Null when neither backend is configured — callers must return 501, not crash. */
export function getSignalStore(): SignalStore | null {
  if (process.env.DATABASE_URL?.trim()) {
    return postgresStore(directNeonUrl(process.env.DATABASE_URL.trim()));
  }
  return supabaseStore();
}

/** Which backend is active, for /api/diagnostics. Never exposes the connection string. */
export function storeKind(): string {
  return getSignalStore()?.kind ?? "none";
}

export interface StoreIdentity {
  kind: "postgres" | "supabase";
  host: string;
  database: string | null;
}

/**
 * Which database this invocation is actually talking to — host and database
 * name, never credentials.
 *
 * Exists because of a failure nothing else could see: every hourly sweep
 * reported its writes as stored, while the board and the monitor read a world
 * frozen a day earlier. That combination is impossible inside one Postgres
 * database — and that is the tell. Vercel's database integrations can mint a
 * *fresh database branch per deployment*, so each push sends writes to a
 * branch the next deployment silently abandons. The only way to catch it from
 * the outside is for every response to say which host answered; when the
 * hostname changes between deployments, that is the whole diagnosis.
 *
 * The hostname is not a secret (connecting still requires the password), and
 * it is exactly the fact the owner needs to compare across screenshots and
 * workflow logs.
 */
export function describeStore(): StoreIdentity | null {
  const url = process.env.DATABASE_URL?.trim();
  if (url) {
    try {
      // The *effective* host — after the pooler rewrite — because this field
      // exists to say where queries actually go, not what the env var says.
      const u = new URL(directNeonUrl(url));
      return {
        kind: "postgres",
        host: u.hostname,
        database: u.pathname.replace(/^\//, "") || null,
      };
    } catch {
      return { kind: "postgres", host: "（連線字串無法解析）", database: null };
    }
  }
  const supa = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (supa) {
    try {
      return { kind: "supabase", host: new URL(supa).hostname, database: null };
    } catch {
      return { kind: "supabase", host: "（連線字串無法解析）", database: null };
    }
  }
  return null;
}

-- Stage 2: persisted signal history for the Vercel Cron job and /history page.
-- Run this once against your Supabase project (SQL editor or `supabase db push`).

create table if not exists public.signals (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  direction text not null check (direction in ('long', 'short')),
  grade text not null check (grade in ('A+', 'A', 'B', 'C', 'no-trade')),
  bias_score integer not null,
  entry_structure_score integer not null,
  total_score integer not null,
  entry_zone jsonb not null,
  stop_loss jsonb not null,
  take_profits jsonb not null,
  bias_items jsonb not null,
  entry_structures jsonb not null,
  path_obstacles jsonb not null,
  narrative text not null,
  trade_plan jsonb not null default '{}'::jsonb,
  plan_backtest jsonb,
  data_gaps jsonb not null default '[]'::jsonb,
  generated_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists signals_symbol_idx on public.signals (symbol);
create index if not exists signals_grade_idx on public.signals (grade);
create index if not exists signals_generated_at_idx on public.signals (generated_at desc);

-- RLS: anyone can read (history page uses the anon key), only the service
-- role (used server-side by the cron route) can write.
alter table public.signals enable row level security;

drop policy if exists "Public read access" on public.signals;
create policy "Public read access" on public.signals
  for select using (true);

-- Migration for tables created before trade_plan existed; no-op on new ones.
alter table public.signals add column if not exists trade_plan jsonb not null default '{}'::jsonb;
alter table public.signals add column if not exists plan_backtest jsonb;

-- ─────────────────────────────────────────────────────────────────
-- Stage 3: 停損復盤與干涉機制
-- Plain SQL — applies to Supabase and to any Postgres (Neon etc.).
-- ─────────────────────────────────────────────────────────────────

create table if not exists public.trade_journal (
  id uuid primary key default gen_random_uuid(),
  -- Null for a manually logged trade that didn't come from a stored signal.
  signal_id uuid references public.signals (id) on delete set null,
  symbol text not null,
  direction text not null check (direction in ('long', 'short')),
  grade text not null check (grade in ('A+', 'A', 'B', 'C', 'no-trade')),
  entry_price double precision not null,
  exit_price double precision not null,
  result text not null check (result in ('win', 'loss', 'breakeven')),
  -- Signed: negative on a loss.
  pnl_pct double precision not null,
  closed_at timestamptz not null,
  -- Only set on losses; the reviewer picks it, never an AI.
  stop_reason_tag text check (stop_reason_tag in ('S1','S2','S3','S4','S5','S6','S7','S8')),
  -- Computed by lib/journal/severity.ts. The check mirrors the formula's clamp
  -- so a hand-written INSERT can't put an out-of-range value in front of the
  -- intervention rules.
  severity integer check (severity between 1 and 5),
  review_note text,
  created_at timestamptz not null default now(),
  -- A loss without a reason tag can't be reviewed or intervened on, and a
  -- severity without a tag has nothing to average against.
  constraint loss_needs_tag check (result <> 'loss' or stop_reason_tag is not null),
  constraint severity_needs_tag check (severity is null or stop_reason_tag is not null)
);

create index if not exists trade_journal_symbol_idx on public.trade_journal (symbol);
create index if not exists trade_journal_tag_idx on public.trade_journal (stop_reason_tag);
-- The intervention engine always reads "latest N for this symbol".
create index if not exists trade_journal_closed_at_idx on public.trade_journal (closed_at desc);

-- RLS mirrors `signals`: public read, service-role write.
alter table public.trade_journal enable row level security;

drop policy if exists "Public read access" on public.trade_journal;
create policy "Public read access" on public.trade_journal
  for select using (true);

-- ─────────────────────────────────────────────────────────────────
-- 5-minute plan monitor: remembers what was last reported per symbol so a
-- position that sits in the same state for hours doesn't re-notify every run.
-- ─────────────────────────────────────────────────────────────────

create table if not exists public.plan_monitor (
  -- One row per symbol: only the newest actionable plan is ever monitored.
  symbol text primary key,
  signal_id uuid references public.signals (id) on delete set null,
  -- Last state reported to the user; see lib/monitor/plan-state.ts.
  state text not null,
  -- Highest add-on sequence already announced (0 = none yet).
  add_ons_filled integer not null default 0,
  -- Stop currently in force, including any add-on adjustment.
  active_stop double precision,
  last_price double precision,
  updated_at timestamptz not null default now()
);

-- Snapshot of the plan being tracked (direction/grade/plan/generatedAt).
-- Added after the table shipped, so it arrives as an alter rather than a
-- column in the create above — "if not exists" makes both paths idempotent.
alter table public.plan_monitor add column if not exists tracked jsonb;

alter table public.plan_monitor enable row level security;

drop policy if exists "Public read access" on public.plan_monitor;
create policy "Public read access" on public.plan_monitor
  for select using (true);

-- ─────────────────────────────────────────────────────────────────
-- 即時數據公布: the first time each macro observation was seen.
--
-- FRED serves observations, not publication timestamps: a CPI reading labelled
-- 2026-07-01 appears without ceremony in mid-August. "When did this become
-- public" is therefore not in the data, and the only honest answer available is
-- "the first scan that saw it" -- which this table records, once, per release.
-- ─────────────────────────────────────────────────────────────────

create table if not exists public.data_release (
  series_id text not null,
  -- The observation's own period label, e.g. 2026-07-01. One row per print.
  period text not null,
  value double precision not null,
  -- The observation before it, so the comparison survives a later revision of
  -- the series without needing to re-fetch history.
  previous_value double precision,
  -- Market consensus when a calendar source supplied one; null otherwise.
  -- Its absence is meaningful: the analysis then compares against the previous
  -- print and says so, rather than implying a beat or a miss.
  estimate double precision,
  first_seen_at timestamptz not null default now(),
  primary key (series_id, period)
);

alter table public.data_release enable row level security;

drop policy if exists "Public read access" on public.data_release;
create policy "Public read access" on public.data_release
  for select using (true);

-- ─────────────────────────────────────────────────────────────────
-- Server-side settings that a browser sets but a scheduler reads.
--
-- The alert channels are the case this exists for. They can't live in
-- localStorage (the cron runs with no browser attached) and requiring a Vercel
-- environment variable means a redeploy for every change, so they live here:
-- written from /setup, read by the 4-hour refresh and the 5-minute monitor.
--
-- Note the missing read policy. Every other table in this file grants public
-- select; this one holds a bot token, so RLS denies anonymous reads and only
-- the service-role key (or a direct DATABASE_URL connection) can see values.
-- ─────────────────────────────────────────────────────────────────

create table if not exists public.app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;

-- ─────────────────────────────────────────────────────────────────
-- The signal currently in force, one row per symbol.
--
-- Separate from `signals` because the two answer different questions and have
-- wildly different write rates. `signals` is an append-only timeline that the
-- 4-hourly scan writes to: nine rows every four hours, ~54 a day, which is what
-- /history and the backtest read.
--
-- This table is what every *view* reads. A browser-initiated scan upserts here
-- instead of appending, because the dashboard rescans nine symbols every five
-- minutes while it is open — 2,600 rows a day, each carrying the full bias
-- items, structures and narrative. That would fill a free-tier database in
-- about three weeks and bury the real history under it.
-- ─────────────────────────────────────────────────────────────────

create table if not exists public.latest_signal (
  symbol text primary key,
  payload jsonb not null,
  generated_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.latest_signal enable row level security;

drop policy if exists "Public read access" on public.latest_signal;
create policy "Public read access" on public.latest_signal
  for select using (true);

-- ─────────────────────────────────────────────────────────────────
-- Cross-invocation cache for the free data sources.
--
-- The in-memory cache in lib/data-sources/cache.ts is per-process, and on
-- Vercel a process handles one request and may never be reused. That made the
-- third tier of fetchFree -- "serve the last good answer, labelled stale" --
-- unreachable in practice: every miss went straight to "取得失敗，且無可用快取",
-- so a source being briefly down became a hole in the analysis rather than a
-- slightly old number.
--
-- Rows are overwritten in place, one per cache key, so this stays small.
-- ─────────────────────────────────────────────────────────────────

create table if not exists public.source_cache (
  cache_key text primary key,
  payload jsonb not null,
  fetched_at timestamptz not null default now()
);

alter table public.source_cache enable row level security;

-- ─────────────────────────────────────────────────────────────────
-- 實驗室前進測試: one paper trade per condition, opened before the
-- outcome is known and resolved on later bars.
--
-- The lab's backtest and this table answer different questions. A backtest
-- asks what a condition would have done on history that already existed when
-- the condition was written; no amount of hold-out splitting fully removes the
-- fact that the search and the data met. This table asks what the condition
-- does on bars nobody had seen when the row was written -- each entry is a
-- pre-registration, timestamped, with its stop and target fixed at entry and
-- never adjusted afterwards.
--
-- One open trade per (symbol, direction, condition) at a time, so a condition
-- that stays true for thirty bars produces a sequence a person could actually
-- have traded rather than thirty overlapping positions. The id is derived from
-- the entry bar, which makes re-running the advance on the same bar a no-op.
-- ─────────────────────────────────────────────────────────────────

create table if not exists public.lab_forward (
  -- symbol:direction:condition:entry_bar_time -- deterministic, so a repeated
  -- run inserts nothing rather than duplicating the trade.
  id text primary key,
  symbol text not null,
  direction text not null check (direction in ('long', 'short')),
  condition_id text not null,
  -- The bar whose close triggered the entry.
  entry_bar_time timestamptz not null,
  entry double precision not null,
  stop double precision not null,
  target double precision not null,
  -- The ATR the geometry was built from, kept so a resolved trade can be
  -- re-checked without recomputing indicators over the whole series.
  atr double precision not null,
  horizon_bars integer not null,
  status text not null check (status in ('open', 'win', 'loss', 'expired')),
  exit_price double precision,
  exit_bar_time timestamptz,
  -- Bars held at resolution; null while open.
  bars_held integer,
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);

create index if not exists lab_forward_status_idx on public.lab_forward (status);
create index if not exists lab_forward_scope_idx on public.lab_forward (symbol, direction, condition_id);

alter table public.lab_forward enable row level security;

drop policy if exists "Public read access" on public.lab_forward;
create policy "Public read access" on public.lab_forward
  for select using (true);

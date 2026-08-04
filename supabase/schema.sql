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

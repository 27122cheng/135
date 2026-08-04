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

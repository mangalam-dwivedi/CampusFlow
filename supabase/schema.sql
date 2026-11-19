create table if not exists public.user_data (
  id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_data enable row level security;

drop policy if exists "Users can manage their own CampusFlow data" on public.user_data;
create policy "Users can manage their own CampusFlow data"
  on public.user_data
  for all
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

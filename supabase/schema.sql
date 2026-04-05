create extension if not exists pgcrypto;

create table if not exists public.app_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  app_key text not null check (app_key in ('budget', 'money-memo')),
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, app_key)
);

alter table public.app_snapshots enable row level security;

create policy "Users can read own app snapshots"
on public.app_snapshots
for select
to authenticated
using (auth.uid() = user_id);

create policy "Users can insert own app snapshots"
on public.app_snapshots
for insert
to authenticated
with check (auth.uid() = user_id);

create policy "Users can update own app snapshots"
on public.app_snapshots
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

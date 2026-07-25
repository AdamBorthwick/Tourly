-- Tourly — Supabase schema (FRESH project only — empty database)
--
-- ⚠️  If you already have a public.tours table, run migrate-shared-backend.sql instead.
--     Running this file on an existing table will fail with "column user_id does not exist".
--
-- OWNER SETUP:
--   1. Enable Authentication → Providers → Anonymous sign-ins
--   2. Run THIS file (fresh) OR migrate-shared-backend.sql (existing)
--   3. Fill tourly-extension/supabase-config.js (gitignored)

create table if not exists public.tours (
  id          uuid primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text,
  page_url    text,
  config      jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists tours_user_idx on public.tours (user_id);
create unique index if not exists tours_user_page_idx on public.tours (user_id, page_url);

alter table public.tours enable row level security;

drop policy if exists "tourly own rows select" on public.tours;
drop policy if exists "tourly own rows insert" on public.tours;
drop policy if exists "tourly own rows update" on public.tours;
drop policy if exists "tourly own rows delete" on public.tours;
drop policy if exists "tourly tours select" on public.tours;
drop policy if exists "tourly tours insert" on public.tours;
drop policy if exists "tourly tours update" on public.tours;
drop policy if exists "tourly tours delete" on public.tours;

create policy "tourly own rows select" on public.tours
  for select to authenticated using (user_id = auth.uid());
create policy "tourly own rows insert" on public.tours
  for insert to authenticated with check (user_id = auth.uid());
create policy "tourly own rows update" on public.tours
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "tourly own rows delete" on public.tours
  for delete to authenticated using (user_id = auth.uid());

create table if not exists public.transcription_cache (
  video_id   text primary key,
  segments   jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.transcription_cache enable row level security;

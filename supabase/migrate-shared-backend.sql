-- ═══════════════════════════════════════════════════════════════════════════
-- RUN THIS in Supabase SQL Editor (existing project with device_id tours table)
-- Safe to run multiple times. Do NOT run schema.sql on an existing table.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Ensure base table exists (legacy installs may already have device_id)
create table if not exists public.tours (
  id          uuid primary key,
  name        text,
  page_url    text,
  config      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 2. Add user_id column (required for anonymous-auth RLS)
alter table public.tours add column if not exists user_id uuid;

-- 3. Drop old device_id-era indexes
drop index if exists public.tours_device_page_idx;
drop index if exists public.tours_device_idx;

-- 4. Drop all old policies (any naming generation)
drop policy if exists "tourly tours select" on public.tours;
drop policy if exists "tourly tours insert" on public.tours;
drop policy if exists "tourly tours update" on public.tours;
drop policy if exists "tourly tours delete" on public.tours;
drop policy if exists "tourly own rows select" on public.tours;
drop policy if exists "tourly own rows insert" on public.tours;
drop policy if exists "tourly own rows update" on public.tours;
drop policy if exists "tourly own rows delete" on public.tours;

-- 5. Default user_id from JWT on insert
alter table public.tours alter column user_id set default auth.uid();

-- 5b. Enforce user_id actually references a real auth identity (cascades cleanup on account deletion)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tours_user_id_fkey') then
    alter table public.tours
      add constraint tours_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;
  end if;
end $$;

-- 6. Indexes (only after user_id column exists)
create index if not exists tours_user_idx on public.tours (user_id);
create unique index if not exists tours_user_page_idx on public.tours (user_id, page_url);

-- 7. RLS — each anonymous JWT only sees its own rows
alter table public.tours enable row level security;

create policy "tourly own rows select" on public.tours
  for select to authenticated using (user_id = auth.uid());
create policy "tourly own rows insert" on public.tours
  for insert to authenticated with check (user_id = auth.uid());
create policy "tourly own rows update" on public.tours
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "tourly own rows delete" on public.tours
  for delete to authenticated using (user_id = auth.uid());

-- 8. Transcription cache (auto-subtitles)
create table if not exists public.transcription_cache (
  video_id   text primary key,
  segments   jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.transcription_cache enable row level security;

-- Old device_id rows (no user_id) won't show for new anonymous users — that's expected.
-- Optional cleanup later: alter table public.tours drop column if exists device_id;

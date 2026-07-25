-- Run this if you ALREADY have a working public.tours table (with device_id)
-- and only need the auto-subtitle transcription cache.
-- Safe to run multiple times.

create table if not exists public.transcription_cache (
  video_id   text primary key,
  segments   jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.transcription_cache enable row level security;

-- The live table still carried leftovers from before the anonymous-auth pivot:
--   1. device_id (NOT NULL) — no longer sent by the client, silently failing every insert.
--   2. "tourly anon all" policy — grants the public `anon` role unrestricted access to
--      every row, bypassing per-user isolation entirely. Dead cruft from an earlier
--      (device-id-era) draft of the schema that was never dropped on migration.
-- Table is empty (0 rows) at the time of this migration, so this is zero-risk.

drop policy if exists "tourly anon all" on public.tours;

alter table public.tours drop column if exists device_id;
alter table public.tours alter column user_id set not null;

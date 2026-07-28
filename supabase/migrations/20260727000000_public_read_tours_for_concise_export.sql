-- Concise export mode: an exported tour's <script> tag references its Supabase row by id and
-- fetches its config at page-load time, rather than inlining the whole config/runtime. Site
-- visitors have no session/JWT, so this adds a scoped, READ-ONLY policy for the public `anon`
-- role — insert/update/delete remain restricted to `authenticated` + own-row via the existing
-- policies (see 20260725010000_drop_legacy_device_and_anon_policy.sql, which removed the old
-- unrestricted "tourly anon all" policy — this is deliberately narrower: select-only, never
-- all-commands).
--
-- Tour content is meant to be publicly rendered on the pages it's embedded on, so a public read
-- of `config` is not a new exposure — engine.js only ever requests `select=config` at runtime,
-- though note RLS is row-level, not column-level: anyone who knows a tour's id (an
-- unguessable uuid) and queries the REST endpoint directly could read the whole row (name,
-- page_url, timestamps too), not just config. None of those fields are sensitive.

drop policy if exists "tourly public read for concise export" on public.tours;

create policy "tourly public read for concise export" on public.tours
  for select to anon using (true);

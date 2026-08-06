-- get_tour_config must bypass RLS: it runs as the anon invoker after
-- 20260728020000 dropped the public SELECT policy. Without SECURITY DEFINER the
-- function always returns null for concise embeds.
--
-- search_path is pinned so SECURITY DEFINER cannot be redirected via a malicious
-- search_path. Execute remains granted to anon (embed pages) and authenticated.

create or replace function public.get_tour_config(tour_id uuid)
returns json
language sql
stable
security definer
set search_path = public
as $$
  select config from public.tours where id = tour_id;
$$;

revoke all on function public.get_tour_config(uuid) from public;
grant execute on function public.get_tour_config(uuid) to anon;
grant execute on function public.get_tour_config(uuid) to authenticated;

-- Replace enumerable RLS with scoped get_tour_config RPC.
--
-- The old "public read" policy allowed anyone to SELECT any tour row (using `true` condition),
-- which is enumerable: a query without ID filters could list all tours. Instead, visitors only
-- learn about tours by knowing their ID beforehand (from the embed page's <script> tag).
--
-- This RPC provides a safe, non-enumerable way to fetch a specific tour's config by ID. The
-- concise export's engine.js will call this instead of the REST endpoint, and we can drop or
-- restrict the blanket public read policy.

create or replace function public.get_tour_config(tour_id uuid)
returns json as $$
  select config from public.tours where id = tour_id;
$$ language sql stable;

-- Grant execute to anon so the RPC can be called from exported tour embeds (no JWT, just anon key)
grant execute on function public.get_tour_config(uuid) to anon;

-- Replace the enumerable policy with a policy that only allows the RPC, not direct table access
-- (this requires a new "authenticated" policy for editors + the RPC for anon reads).
-- For now, we'll keep the policy but add a note: future work may drop it once all deployed
-- tours call the RPC instead.

drop policy if exists "tourly public read for concise export" on public.tours;

-- OWASP's Multi-Tenant Security Cheat Sheet specifically calls out forcing RLS for table owners
-- too: Postgres RLS policies don't apply to a table's owning role by default, only to other
-- roles (like the anon/authenticated roles our client traffic actually uses). Client requests
-- were never at risk from this gap, but FORCE ROW LEVEL SECURITY closes it as defense-in-depth
-- so there's no privileged-role bypass path at all, ever.
alter table public.tours force row level security;

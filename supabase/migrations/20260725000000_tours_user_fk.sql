-- Enforce that tours.user_id references a real auth identity, and cascade-delete
-- a user's tours if their (anonymous) auth identity is ever removed.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tours_user_id_fkey') then
    alter table public.tours
      add constraint tours_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;
  end if;
end $$;

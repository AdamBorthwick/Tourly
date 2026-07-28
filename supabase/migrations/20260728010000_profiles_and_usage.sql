-- Phase 6: entitlement foundation (profiles) + usage tracking for the transcription rate limit.

create table if not exists public.profiles (
  id                      uuid primary key references auth.users(id) on delete cascade,
  email                   text,
  plan                    text not null default 'free' check (plan in ('free', 'pro')),
  stripe_customer_id      text,
  stripe_subscription_id  text,
  subscription_status     text,
  current_period_end      timestamptz,
  transcribe_count        int not null default 0,
  transcribe_reset_at     timestamptz not null default (now() + interval '30 days'),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.profiles force row level security;

-- Read-only for the owning user. No client insert/update/delete policies at all — rows are
-- created by the trigger below (fires only on a real auth.users insert) and updated only by
-- trusted server-side code (the transcribe function today; the Stripe webhook function later),
-- both using the service-role key, which bypasses RLS entirely. A client can never set its own
-- plan or reset its own quota.
drop policy if exists "profiles select own" on public.profiles;
create policy "profiles select own" on public.profiles
  for select to authenticated using (id = auth.uid());

-- Auto-create a profile row the moment a new auth identity exists — including anonymous
-- sign-ups, so the transcription rate limit has somewhere to store its counters even before
-- anyone adds an email or subscribes to anything.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Global daily circuit breaker for the transcription function — independent of any one user's
-- quota, insurance against a leaked OpenAI key or a bug. Service-role only, same trust boundary
-- as transcription_cache: RLS enabled with zero client-facing policies.
create table if not exists public.usage_global (
  day    date primary key,
  count  int not null default 0
);
alter table public.usage_global enable row level security;
alter table public.usage_global force row level security;

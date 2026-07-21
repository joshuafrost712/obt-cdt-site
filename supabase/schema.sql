-- OBT-CDT site backend schema (Phase 2). Run once in the Supabase SQL editor
-- of a fresh project (safe to re-run: idempotent where possible).
--
-- Design notes are in docs/PHASE-2-BACKEND.md. Summary:
--   * Participants read ONLY their own registrations/evaluations/certificates.
--   * Evaluations and certificates are written by the evaluation pipeline or
--     an admin in the dashboard, never by participants (no insert policies).
--   * Event availability is the events.status field, managed by an admin, so
--     no client ever needs to count other people's registrations.

-- ---------------------------------------------------------------- profiles
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  full_name text not null default '',
  org text not null default '',
  role text not null default 'participant'
    check (role in ('participant', 'mentor', 'admin')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
  for update using (auth.uid() = id);

-- Auto-create a profile row on signup.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------------ events
-- ids match the workshop ids in src/content/site-content.json (stable-ids
-- rule), so marketing pages and backend rows describe the same thing.
create table if not exists public.events (
  id text primary key,
  title text not null,
  location text not null default '',
  start_date date,
  end_date date,
  capacity int,
  status text not null default 'open'
    check (status in ('open', 'fully-booked', 'completed', 'cancelled')),
  description text not null default '',
  created_at timestamptz not null default now()
);

alter table public.events enable row level security;

drop policy if exists "events readable by signed-in users" on public.events;
create policy "events readable by signed-in users" on public.events
  for select to authenticated using (true);

-- ----------------------------------------------------------- registrations
create table if not exists public.registrations (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles on delete cascade,
  event_id text not null references public.events on delete cascade,
  status text not null default 'registered'
    check (status in ('registered', 'waitlist', 'attended', 'cancelled')),
  created_at timestamptz not null default now(),
  unique (profile_id, event_id)
);

alter table public.registrations enable row level security;

drop policy if exists "read own registrations" on public.registrations;
create policy "read own registrations" on public.registrations
  for select using (auth.uid() = profile_id);

drop policy if exists "register self" on public.registrations;
create policy "register self" on public.registrations
  for insert with check (
    auth.uid() = profile_id
    and status in ('registered', 'waitlist')
    and exists (
      select 1 from public.events e
      where e.id = event_id and e.status in ('open', 'fully-booked')
    )
  );

drop policy if exists "update own registration" on public.registrations;
create policy "update own registration" on public.registrations
  for update using (auth.uid() = profile_id)
  with check (status in ('registered', 'waitlist', 'cancelled'));

-- -------------------------------------------------------------------- ksas
-- Stable registry of competency sub-points evaluations refer to.
create table if not exists public.ksas (
  id text primary key,
  competency text not null,
  label text not null
);

alter table public.ksas enable row level security;

drop policy if exists "ksas readable by signed-in users" on public.ksas;
create policy "ksas readable by signed-in users" on public.ksas
  for select to authenticated using (true);

-- ------------------------------------------------------------- evaluations
create table if not exists public.evaluations (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles on delete cascade,
  ksa_id text not null references public.ksas,
  score int not null check (score between 0 and 3),
  evaluator text not null default '',
  note text not null default '',
  occasion text references public.events (id),
  created_at timestamptz not null default now()
);

alter table public.evaluations enable row level security;

drop policy if exists "read own evaluations" on public.evaluations;
create policy "read own evaluations" on public.evaluations
  for select using (auth.uid() = profile_id);
-- No insert/update policies: evidence enters via service role / dashboard.

-- ------------------------------------------------------------ certificates
create table if not exists public.certificates (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles on delete cascade,
  event_id text not null references public.events,
  issued_at date not null default current_date,
  template text not null default 'v1'
);

alter table public.certificates enable row level security;

drop policy if exists "read own certificates" on public.certificates;
create policy "read own certificates" on public.certificates
  for select using (auth.uid() = profile_id);
-- No insert policy: certificates are issued via service role / dashboard.

-- -------------------------------------------------------------------- seed
insert into public.events (id, title, location, start_date, end_date, capacity, status, description)
values
  ('narrative-bangalore-2025', 'Workshop 1 · Narrative', 'Bangalore, India', '2025-06-02', '2025-06-13', null, 'completed', 'Foundational OBT skills practiced on biblical narrative.'),
  ('epistles-chiang-mai-2025', 'Workshop 2 · Epistles', 'Chiang Mai, Thailand', '2025-11-03', '2025-11-14', null, 'completed', 'Argument structure and prominence, with mentored consultant checks.'),
  ('psalms-bali-2026', 'Workshop 3 · Psalms', 'Bali, Indonesia', '2026-08-24', '2026-09-04', 30, 'fully-booked', 'Hebrew poetry exegesis for OBT and translation into local artistic genres.')
on conflict (id) do nothing;

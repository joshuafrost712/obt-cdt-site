-- OBT-CDT Member Portal — baseline.
--
-- This is the first migration of the portal's OWN Supabase project. It replaces
-- `supabase/schema.sql`, which was a run-once script written for a fresh project
-- back when the portal was going to carry event registration and certificates.
-- That file is kept for its design notes and must not be run; see its header.
--
-- ## Why this is a separate project from Honest Eval
--
-- Honest Eval (repo `cairn`, project `vdbirmjvjzfdgajwgowj`) is being built as a
-- product for SIL and other organizations broadly. It cannot also be the OBT-CDT
-- website's database. Reports cross from there to here over a signed one-way
-- publish; nothing here reaches back.
--
-- ## Two deliberate departures from schema.sql
--
-- 1. **`profiles.role` is gone.** schema.sql had `role text check (role in
--    ('participant','mentor','admin'))` plus an UPDATE policy of
--    `using (auth.uid() = id)` and NO `with check`. Postgres reuses the USING
--    expression when WITH CHECK is absent, and the row still satisfies it after
--    `role` changes — so any signed-in participant could have run
--    `update profiles set role='admin' where id = auth.uid()`. Rather than patch
--    the policy, the column is removed: administrator-ness must not live in a row
--    its own subject can update. It lives in `portal_admin` (next migration).
--
-- 2. **`profiles.email` exists and is NOT self-writable.** It is the key that
--    incoming reports are matched on. A member who could edit it could claim
--    another person's unmatched reports, which is the worst outcome this system
--    has. Column-level grants are what actually enforce that; the WITH CHECK
--    below is belt-and-braces, because an RLS policy cannot restrict columns.

-- ---------------------------------------------------------------- profiles
create table if not exists public.profiles (
  id         uuid primary key references auth.users on delete cascade,
  -- Mirrored from auth.users at signup. Mirrored rather than joined so the
  -- report-matching rule lives in inspectable SQL in `public`, and so the ingest
  -- path is one query instead of an admin-API call.
  email      text not null,
  full_name  text not null default '',
  org        text not null default '',
  created_at timestamptz not null default now()
);

create unique index if not exists profiles_email_lower_idx
  on public.profiles (lower(email));

alter table public.profiles enable row level security;

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
  for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- The real column boundary. RLS cannot express "these columns only", so the
-- grant does. Without this line the WITH CHECK above still admits an email
-- change, because the row keeps satisfying `auth.uid() = id`.
revoke update on public.profiles from authenticated;
grant update (full_name, org) on public.profiles to authenticated;

-- No insert or delete policy: rows arrive only from the signup trigger below.

-- -------------------------------------------------------- member allowlist
-- "We don't want just anyone to be able to become a member for security
-- reasons" — Joshua's original requirement, and this table is it.
--
-- Seeded from the OBT-CDT sign-up sheet ("Running list of eligible OBT Workshop
-- Attendees", Master tab, keyed on Primary Email). Being on it means you may
-- create an account; it does NOT mean you have reports. Accepted attendees have
-- their accounts pre-created and will also appear here.
--
-- No policies and no grants: this is read only by the signup trigger, which runs
-- as definer. A client that could read it could enumerate the cohort.
create table if not exists public.member_allowlist (
  email      text primary key,
  note       text not null default '',
  added_at   timestamptz not null default now()
);

alter table public.member_allowlist enable row level security;
revoke all on table public.member_allowlist from public, anon, authenticated;

-- Auto-create a profile row on signup, and refuse a stranger.
--
-- Named `handle_new_portal_user` and not `handle_new_user`. The name is free in
-- this project, but Honest Eval's invite-only auth gate is a function of exactly
-- that name on exactly that trigger, and the two schemas are close enough
-- relatives that a file could one day be pasted into the wrong SQL editor. There
-- is no cost to a name that cannot be confused.
--
-- Raising here rolls back the `auth.users` insert, so a refused signup leaves no
-- account behind. Note that GoTrue swallows this sentence and returns
-- `{"code":500,"error_code":"unexpected_failure","msg":"Database error saving
-- new user"}` — src/lib/backend/signinErrors.ts is what turns that back into
-- something a person can act on, and it pins the string in a test because it is
-- a fact about somebody else's service.
create or replace function public.handle_new_portal_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare _norm text := lower(btrim(new.email));
begin
  if not exists (select 1 from member_allowlist where email = _norm) then
    raise exception 'That address is not on the OBT-CDT participant list.'
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    _norm,
    coalesce(new.raw_user_meta_data ->> 'full_name', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_portal_user();

-- ------------------------------------------------------------------ events
-- ids match the workshop node ids in src/content/site-content.json (the
-- stable-ids rule), so the marketing pages and the portal describe the same
-- thing. They are ALSO the key Honest Eval publishes against: a workshop there
-- carries an `external_key` equal to one of these ids. That is why reports can
-- be grouped by workshop without either system learning the other's UUIDs.
create table if not exists public.events (
  id          text primary key,
  title       text not null,
  location    text not null default '',
  start_date  date,
  end_date    date,
  status      text not null default 'open'
    check (status in ('open', 'fully-booked', 'completed', 'cancelled')),
  description text not null default '',
  created_at  timestamptz not null default now()
);

alter table public.events enable row level security;

drop policy if exists "events readable by signed-in users" on public.events;
create policy "events readable by signed-in users" on public.events
  for select to authenticated using (true);

insert into public.events (id, title, location, start_date, end_date, status, description)
values
  ('narrative-bangalore-2025', 'Workshop 1 · Narrative', 'Bangalore, India',
   '2025-06-02', '2025-06-13', 'completed',
   'Foundational OBT skills practiced on biblical narrative.'),
  ('epistles-chiang-mai-2025', 'Workshop 2 · Epistles', 'Chiang Mai, Thailand',
   '2025-11-03', '2025-11-14', 'completed',
   'Argument structure and prominence, with mentored consultant checks.'),
  ('psalms-bali-2026', 'Workshop 3 · Psalms', 'Bali, Indonesia',
   '2026-08-24', '2026-09-04', 'fully-booked',
   'Hebrew poetry exegesis for OBT and translation into local artistic genres.'),
  -- The week BEFORE Psalms, not alongside it: site-content.json says "Crash
  -- Course: 18 to 22 August", Tuesday to Saturday because the 17th is an
  -- Indonesian public holiday. Crash Course people are in Bali for three weeks,
  -- Psalms-only people for two. It has its own roster in Honest Eval and
  -- therefore needs its own event row, or its reports arrive with no workshop to
  -- group under.
  ('crash-course-bali-2026', 'OBT Crash Course', 'Bali, Indonesia',
   '2026-08-18', '2026-08-22', 'fully-booked',
   'The one-week experiential doorway: each participant learns oral Bible translation by doing it.'),
  -- Not a workshop and not the Crash Course, despite both being 2026 Hebrew-ish
  -- and both feeding Bali. This is the online alphabet-memorization series (the
  -- sign-up workbook's "Hebrew Training" tab and its own intake form). It is here
  -- because Joshua's stated purpose for this login is every future OBT-CDT online
  -- training, not only the residential ones. It publishes nothing today, so the
  -- row is inert until it does.
  ('hebrew-training-2026', 'Hebrew Alphabet Training', 'Online',
   null, null, 'completed',
   'Online sessions memorizing the Hebrew alphabet, ahead of the Psalms workshop.')
on conflict (id) do nothing;

-- ------------------------------------------------------------------- notes
-- Deliberately NOT created here: `registrations`, `ksas`, `evaluations`,
-- `certificates`. They were designed in docs/PHASE-2-BACKEND.md for a portal
-- that did event sign-up and issued certificates. Phase 1 is reports only, and a
-- table that exists but is never written is a standing invitation to write to it
-- from somewhere unaudited. They come back when those features do.

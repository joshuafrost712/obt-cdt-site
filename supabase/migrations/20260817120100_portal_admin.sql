-- OBT-CDT Member Portal — the administrator model.
--
-- Joshua administers this site today and intends to stop. So the requirement is
-- not "let Joshua in", it is "let Joshua hand this to someone else without a
-- developer in the room". That rules out an email in a migration, and it rules
-- out `profiles.role`, which the baseline removed for a separate reason.
--
-- ## Bootstrap
--
-- This table starts EMPTY. Joshua signs up through the portal like anyone else,
-- then one statement is run once against this project:
--
--     insert into portal_admin (profile_id, is_owner)
--     select id, true from profiles where lower(email) = lower('<his address>');
--
-- The alternative considered was a one-time `claim-ownership` Edge Function
-- gated on a bootstrap secret. It was rejected: it is a public endpoint, a
-- secret to store and rotate, and a mechanism to disarm afterwards, all to
-- replace a statement run once. Everything AFTER the first admin — which is the
-- part that actually has to be self-service — goes through the RPCs below.
--
-- First-signup-wins was also rejected: the sign-in page is public, so the first
-- stranger would become the owner.

create table if not exists public.portal_admin (
  -- `on delete restrict`, not cascade. Deleting the last administrator's account
  -- must fail loudly rather than quietly emptying this table and locking
  -- everybody out of their own site.
  profile_id uuid primary key references public.profiles(id) on delete restrict,
  is_owner   boolean not null default false,
  added_by   uuid references public.profiles(id) on delete set null,
  added_at   timestamptz not null default now()
);

-- "Exactly one owner" as a database fact rather than an application promise.
create unique index if not exists portal_admin_single_owner
  on public.portal_admin ((is_owner)) where is_owner;

alter table public.portal_admin enable row level security;

-- No write policies and no write grants. Every mutation goes through the
-- security-definer RPCs below, which is what lets the invariants be enforced in
-- one place. Revoking by role name explicitly, not just `from public`: Supabase
-- grants `anon` and `authenticated` directly, and a `revoke ... from public`
-- leaves those grants standing. That exact mistake has already shipped once in
-- the sibling project (cairn's 20260806000100_hosted_routing.sql).
revoke all on table public.portal_admin from public, anon, authenticated;
grant select on table public.portal_admin to authenticated;

-- ---------------------------------------------------------------- helpers
--
-- SECURITY DEFINER matters here beyond convenience: the read policy below calls
-- this function, and a policy on `portal_admin` that itself queries
-- `portal_admin` under RLS would recurse forever. Running as the owner bypasses
-- RLS and breaks the cycle.
create or replace function public.is_portal_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from portal_admin where profile_id = auth.uid()
  );
$$;

create or replace function public.is_portal_owner()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from portal_admin where profile_id = auth.uid() and is_owner
  );
$$;

revoke all on function public.is_portal_admin() from public, anon;
revoke all on function public.is_portal_owner() from public, anon;
grant execute on function public.is_portal_admin() to authenticated;
grant execute on function public.is_portal_owner() to authenticated;

drop policy if exists "admins read the admin list" on public.portal_admin;
create policy "admins read the admin list" on public.portal_admin
  for select to authenticated using (is_portal_admin());

-- ------------------------------------------------------------------- RPCs

create or replace function public.add_portal_admin(_profile_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not is_portal_admin() then
    raise exception 'Only an OBT-CDT administrator can add another administrator.'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from profiles where id = _profile_id) then
    raise exception 'That person has not signed in to the portal yet, so there is no account to promote.'
      using errcode = 'no_data_found';
  end if;
  insert into portal_admin (profile_id, added_by)
  values (_profile_id, auth.uid())
  on conflict (profile_id) do nothing;
end;
$$;

create or replace function public.remove_portal_admin(_profile_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare _remaining int;
begin
  if not is_portal_admin() then
    raise exception 'Only an OBT-CDT administrator can remove an administrator.'
      using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from portal_admin where profile_id = _profile_id and is_owner) then
    raise exception 'The owner cannot be removed. Transfer ownership first, then remove them.'
      using errcode = 'check_violation';
  end if;
  select count(*) into _remaining from portal_admin;
  if _remaining <= 1 then
    raise exception 'This is the last administrator. Add another one before removing this one.'
      using errcode = 'check_violation';
  end if;
  delete from portal_admin where profile_id = _profile_id;
end;
$$;

-- The same invariant, enforced a second time at the table.
--
-- Two layers is not belt-and-braces here, it is two different doors: the RPC is
-- the door a person uses and the trigger is the door a service-role script or a
-- hand-typed statement uses, and only one of those gets reviewed.
create or replace function public.portal_admin_guard_last()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if (select count(*) from portal_admin) <= 1 then
    raise exception 'Refusing to delete the last OBT-CDT administrator.'
      using errcode = 'check_violation';
  end if;
  return old;
end;
$$;

drop trigger if exists portal_admin_guard_last_trigger on public.portal_admin;
create trigger portal_admin_guard_last_trigger
  before delete on public.portal_admin
  for each row execute function public.portal_admin_guard_last();

create or replace function public.transfer_portal_ownership(_to_profile_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare _current uuid;
begin
  -- Lock the current owner row first. Without this, two transfers racing each
  -- other can both read "I am the owner", both clear it, and both set a new one
  -- — and the partial unique index then rejects whichever commits second, which
  -- looks to that administrator like a random failure rather than a conflict.
  select profile_id into _current from portal_admin where is_owner for update;

  if _current is null or _current <> auth.uid() then
    raise exception 'Only the current owner can transfer ownership.'
      using errcode = 'insufficient_privilege';
  end if;
  -- The target must already be an administrator. Ownership is the last thing
  -- you hand over, not the first, and this makes a mistyped id fail closed
  -- instead of handing the site to a stranger.
  if not exists (select 1 from portal_admin where profile_id = _to_profile_id) then
    raise exception 'Make that person an administrator first, then transfer ownership to them.'
      using errcode = 'check_violation';
  end if;
  if _to_profile_id = _current then
    return;
  end if;

  update portal_admin set is_owner = false where profile_id = _current;
  update portal_admin set is_owner = true  where profile_id = _to_profile_id;
end;
$$;

revoke all on function public.add_portal_admin(uuid) from public, anon;
revoke all on function public.remove_portal_admin(uuid) from public, anon;
revoke all on function public.transfer_portal_ownership(uuid) from public, anon;
grant execute on function public.add_portal_admin(uuid) to authenticated;
grant execute on function public.remove_portal_admin(uuid) to authenticated;
grant execute on function public.transfer_portal_ownership(uuid) to authenticated;

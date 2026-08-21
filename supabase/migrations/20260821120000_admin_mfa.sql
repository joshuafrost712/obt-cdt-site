-- OBT-CDT Member Portal — require two-factor authentication for administration,
-- and close the one admin path that did not go through the helpers.
--
-- Spec CDT-00 D6. This is a NEW migration and not an edit to 20260817120100.
-- `supabase db push` records applied migrations by filename and skips them, so
-- editing an applied file leaves the repo and the live database silently
-- disagreeing, and a future push against a rebuilt project applies a different
-- schema than the one that was reviewed.
--
-- ## STATUS: NOT YET APPLIED (as of 2026-08-21)
--
-- The portal's Supabase project is not reachable from the build session that
-- wrote this file: the repo has no Actions variables, the deployed bundle
-- contains no Supabase origin, and the project reference and publishable key
-- have not been supplied. So this migration is reviewed but unrun. Apply it with
-- `supabase link` plus `supabase db push`, in the order below.
--
-- ## Apply order, which is load-bearing
--
--   1. Enable TOTP (app authenticator) enrolment in the project's Auth settings.
--      Without it no factor can be created at all.
--   2. Run `node scripts/mfa-enrol.mjs` as the administrator and confirm the
--      printed access token carries `"aal": "aal2"`.
--   3. Apply this migration.
--   4. Verify both directions: an aal1 session is refused on
--      admin_unmatched_publications, add_portal_admin and
--      transfer_portal_ownership; an aal2 session is admitted on all three.
--
-- Getting that order wrong locks the only administrator out of every admin read
-- and every admin RPC, INCLUDING the ones that would add a second
-- administrator. And because a denied read under RLS is a silent filter rather
-- than an error, the symptom is an empty page, not a message.
--
-- The DO block below makes that mistake structurally impossible rather than
-- merely documented: it refuses to run unless some portal_admin already has a
-- verified MFA factor. An empty portal_admin table also refuses, which is
-- correct, because enforcing aal2 before an owner exists would make the
-- bootstrap insert unreachable.
--
-- ## Rollback, in full
--
--   create or replace function public.is_portal_admin()
--   returns boolean language sql stable security definer set search_path = public
--   as $$ select exists (select 1 from portal_admin where profile_id = auth.uid()); $$;
--
--   create or replace function public.is_portal_owner()
--   returns boolean language sql stable security definer set search_path = public
--   as $$ select exists (select 1 from portal_admin where profile_id = auth.uid() and is_owner); $$;
--
-- The transfer_portal_ownership change below does not need rolling back: it is
-- strictly a tightening, and the inline owner comparison it replaces is still
-- performed after the row lock.
--
-- ## Tables this migration owns
--
-- None. It creates no table and no policy. It replaces four functions, all of
-- them declared in 20260817120100_portal_admin.sql, plus EXECUTE grants on three
-- trigger functions declared in the baseline and publication migrations.

-- --------------------------------------------------------------- safety gate
do $$
declare _enrolled int;
begin
  select count(*) into _enrolled
    from public.portal_admin pa
    join auth.mfa_factors f on f.user_id = pa.profile_id
   where f.status = 'verified';

  if _enrolled = 0 then
    raise exception
      'Refusing to require aal2: no portal administrator has a verified MFA factor yet. %',
      'Enable TOTP in the project Auth settings, run scripts/mfa-enrol.mjs, confirm an aal2 token, then apply this migration. See the header.'
      using errcode = 'insufficient_privilege';
  end if;

  raise notice 'aal2 gate: % administrator(s) have a verified factor', _enrolled;
end $$;

-- ------------------------------------------------------------- the helpers
--
-- The requirement lives in the helpers rather than in each policy because there
-- are six call sites in shipped SQL (four policies and two RPCs), and a rule
-- applied at five of six is worse than no rule.
--
-- `coalesce(..., 'aal1')` fails closed: a token with no aal claim is treated as
-- single-factor rather than waved through.

create or replace function public.is_portal_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
     and exists (select 1 from portal_admin where profile_id = auth.uid());
$$;

create or replace function public.is_portal_owner()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
     and exists (
       select 1 from portal_admin where profile_id = auth.uid() and is_owner
     );
$$;

-- ------------------------------------------------- the unguarded admin path
--
-- Before this, `is_portal_owner()` had no call site anywhere in the schema and
-- `transfer_portal_ownership` checked the owner inline. So the one RPC that hands
-- the entire site to another account was the single admin path that did not run
-- through a helper, and adding the aal2 clause to the helpers alone would have
-- left it reachable at aal1. That is exactly the "a rule applied at five of six
-- places" failure the design argues against, committed by the design.

create or replace function public.transfer_portal_ownership(_to_profile_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare _current uuid;
begin
  if not is_portal_owner() then
    raise exception 'Only the current owner can transfer ownership, in a session that has completed two-factor authentication.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Lock the current owner row. Without this, two transfers racing each other
  -- can both read "I am the owner", both clear it, and both set a new one, and
  -- the partial unique index then rejects whichever commits second, which looks
  -- to that administrator like a random failure rather than a conflict.
  select profile_id into _current from portal_admin where is_owner for update;

  -- Re-checked after the lock, deliberately. is_portal_owner() is STABLE and
  -- read before the lock was taken, so this closes the window between them.
  if _current is null or _current <> auth.uid() then
    raise exception 'Only the current owner can transfer ownership.'
      using errcode = 'insufficient_privilege';
  end if;

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

revoke all on function public.transfer_portal_ownership(uuid) from public, anon;
grant execute on function public.transfer_portal_ownership(uuid) to authenticated;

-- ------------------------------------------- EXECUTE on the trigger functions
--
-- From the CDT-00 D7 audit, question 5. Postgres grants EXECUTE to PUBLIC on
-- every new function, so a function that never revokes it is callable by `anon`
-- and `authenticated`. Three security-definer functions in the existing
-- migrations never revoked it:
--
--   handle_new_portal_user             (baseline)
--   portal_admin_guard_last            (portal_admin)
--   publication_claim_for_new_profile  (publication)
--
-- None of the three is exploitable today, because Postgres refuses a direct call
-- to a trigger function with "trigger functions can only be called as triggers"
-- (SQLSTATE 0A000) before the body runs. So this is closing a pattern, not a
-- hole. It is worth closing anyway for two reasons: CDT-01 and CDT-02 will copy
-- whatever shape they find here, and the exemption depends on a Postgres detail
-- rather than on anything this schema controls.

revoke all on function public.handle_new_portal_user() from public, anon, authenticated;
revoke all on function public.portal_admin_guard_last() from public, anon, authenticated;
revoke all on function public.publication_claim_for_new_profile() from public, anon, authenticated;

-- No grant follows, on purpose. A trigger function is invoked by the trigger's
-- owner, not by the client role, so nobody needs EXECUTE on these.

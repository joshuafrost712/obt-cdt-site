-- ###########################################################################
-- Spec CDT-04, second migration. A consultant could not see who their CIT was.
--
-- ## How this was found
--
-- Not by reading the spec. By writing the queue and asking where the CIT's name
-- comes from. Measured 2026-08-21 against the live project:
--
--   profiles  SELECT  (auth.uid() = id)
--
-- That is the baseline migration's policy (`20260817120000_baseline.sql`), and it
-- is right for what the baseline was: a member portal where the only profile you
-- read is your own. The assessment spine changed the shape of the problem and did
-- not revisit it. So `assignment` gives a consultant the row, `assessment_bundle`
-- gives them the occasion, `cit_enrollment` gives them the assessment language —
-- and nothing anywhere gives them the name of the person they are about to spend
-- two hours examining.
--
-- CDT-04's criterion 10 asserts "the CIT name plus bundle plus date within the
-- first 200px at 390px", and its goal sentence is "sees the assignments that are
-- actually theirs". Neither is reachable. A UI cannot work around this: the name
-- is not on the wire.
--
-- ## What this opens, stated narrowly
--
-- Reach follows an assignment, in both directions, and nothing else:
--
--   * your own profile, as before;
--   * the profile of someone on the other side of an assignment you are party to
--     — a consultant reads their CIT, and the CIT reads their consultant, because
--     a CIT who cannot see who is assessing them cannot prepare for the call
--     either;
--   * oversight reads all, which `is_head_mentor()` and `is_portal_admin()`
--     already gate behind aal2.
--
-- What it does NOT open: the cohort. There is no "all participants" read here.
-- A consultant with three assignments reads three profiles. `member_allowlist`
-- stays revoked from every client role, so the roster is still not readable by
-- anyone, and that is what keeps rubric row 1 true.
--
-- ## Why a definer helper rather than the expression inline
--
-- CDT-02's D7 note, applied: `profiles`' policy would otherwise query
-- `assignment`, whose own SELECT policy calls `may_see_assignment()`. Keeping the
-- reach in a `security definer` function with a pinned `search_path` bypasses RLS
-- inside the helper and blocks SQL inlining, which is what stops a policy loop
-- from reappearing later. It is also the pattern the other three read helpers
-- already follow, and one-off shapes are how a schema stops being readable.
--
-- Objects this migration owns: may_see_profile(uuid), and the SELECT policy
-- "a profile is visible to its owner, assignment counterparties, and oversight"
-- on public.profiles. It replaces the baseline's "profiles are self-readable"
-- policy by name, and declares no table.
-- ###########################################################################

create or replace function public.may_see_profile(_profile uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select _profile = auth.uid()
      or exists (
           select 1 from assignment a
            where (a.consultant_profile_id = auth.uid() and a.subject_profile_id = _profile)
               or (a.subject_profile_id = auth.uid() and a.consultant_profile_id = _profile)
         )
      or is_head_mentor() or is_portal_admin();
$$;

revoke execute on function public.may_see_profile(uuid) from public, anon;
grant execute on function public.may_see_profile(uuid) to authenticated;

-- The baseline's policy is named `read own profile`, read off `pg_policies` rather
-- than guessed: the first draft of this file guessed two other names, and the
-- assertion at the foot caught it, because a leftover permissive policy ORs with
-- this one and a policy that is still there is still enforced. That is the whole
-- argument for asserting the outcome instead of trusting the DROP.
drop policy if exists "read own profile" on public.profiles;
drop policy if exists "a profile is visible to its owner, assignment counterparties, and oversight" on public.profiles;

create policy "a profile is visible to its owner, assignment counterparties, and oversight" on public.profiles
  for select to authenticated using (may_see_profile(id));

-- The UPDATE policy is deliberately untouched: a profile is still editable only
-- by its owner. Reach to read is not reach to write, and widening both in one
-- migration is how the two get confused later.

do $$
declare _n int;
begin
  select count(*) into _n
    from pg_policies
   where schemaname = 'public' and tablename = 'profiles' and cmd = 'SELECT';
  if _n <> 1 then
    raise exception 'expected exactly 1 select policy on profiles, found % (a leftover ORs with the new one)', _n;
  end if;

  select count(*) into _n
    from pg_policies
   where schemaname = 'public' and tablename = 'profiles' and cmd = 'UPDATE'
     and qual = '(auth.uid() = id)';
  if _n <> 1 then
    raise exception 'the profiles update policy is no longer owner-only';
  end if;

  if has_function_privilege('anon', 'public.may_see_profile(uuid)', 'execute') then
    raise exception 'anon holds EXECUTE on may_see_profile';
  end if;
end $$;

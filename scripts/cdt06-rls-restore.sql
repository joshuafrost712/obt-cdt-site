-- CDT-06a D7: put back every object this harness replaces.
--
--   node scripts/cdt06-fixtures.mjs --sql scripts/cdt06-rls-restore.sql
--
-- ## Why this file exists when the SQL half already rolls back
--
-- D7's rule is that the restore runs unconditionally, whether the harness passed,
-- failed or died, because a session that dies mid-mutation would otherwise leave
-- `is_head_mentor()` without its aal2 clause on a database holding participant
-- write-ups. Two paths need covering and only one of them is a transaction:
--
--   * `cdt06-rls-tests.sql` wraps everything in `begin; … rollback;`, so its two
--     mutations cannot survive even a killed connection. This file is the backstop
--     for anyone who runs that file through psql without the wrapper.
--   * `cdt06-ui.mjs` widens the `submission` read policy and COMMITS, because the
--     browser reads over a separate connection and cannot see an uncommitted
--     change. That mutation genuinely needs this file, and the UI harness runs it
--     in a `finally` block.
--
-- ## The definitions below are captures, not re-derivations
--
-- Both were read out of the live project on 2026-08-22 with
-- `pg_get_functiondef()` and `pg_policies`, before anything was mutated, and are
-- pasted here verbatim. That matters: a restore written from the migration file
-- would silently undo any later hotfix, and a restore written from memory is how
-- a control comes back subtly different with nobody looking for it.
--
-- `is_head_mentor()` carries the aal2 clause because CDT-02 D6 shipped it. Note
-- that `is_portal_admin()` does NOT, because CDT-00's `20260821120000_admin_mfa.sql`
-- is unapplied — that is this session's headline finding and is reported, not
-- fixed here. Nothing in this file touches `is_portal_admin()`.

begin;

-- ------------------------------------------- capture 1: is_head_mentor()
-- Source: pg_get_functiondef('public.is_head_mentor()'::regprocedure), live,
-- 2026-08-22, before any mutation in this session.

create or replace function public.is_head_mentor()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
     and exists (select 1 from head_mentor where profile_id = auth.uid());
$function$;

-- ------------------------------------- capture 2: helper 3, may_see_submission()
-- Source: pg_get_functiondef('public.may_see_submission(uuid)'::regprocedure),
-- live, 2026-08-22, before any mutation in this session.
--
-- This is the object the UI half mutates. It reaches by AUTHOR (plus a released
-- write-up's subject, plus oversight). The mutation adds `may_see_subject()`,
-- which is the widening CDT-02's review found and removed: with it, any
-- consultant holding an assignment for a CIT reads every other consultant's
-- write-up about that CIT, which silently destroys the round's second-rating
-- design. Note it is the FUNCTION and not the policy that has to be restored:
-- `submission` and `submission_rating` both call this helper from their own
-- policies, so putting back one policy would leave the other open.

create or replace function public.may_see_submission(_submission_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select exists (
    select 1 from submission s join assignment a on a.id = s.assignment_id
     where s.id = _submission_id
       and (s.consultant_profile_id = auth.uid()
         or (a.subject_profile_id = auth.uid() and s.released_at is not null))
  ) or is_head_mentor() or is_portal_admin();
$function$;

-- ------------------------------- capture 3: the submission read policy
-- Source: pg_policies, live, 2026-08-22. Restored too, because an earlier version
-- of the UI harness mutated this rather than the helper, and a restore file that
-- only covers the current mutation is a restore file that stops working the next
-- time somebody edits the harness.

drop policy if exists "a write-up is visible to its author, oversight, and the subject"
  on public.submission;
create policy "a write-up is visible to its author, oversight, and the subject"
  on public.submission for select to authenticated
  using (may_see_submission(id));

-- ------------------------------------------------------------ the diff
-- A restore that silently differs is worse than a mutation left in place, because
-- nobody is looking for it. So this file ends by asserting the restored state
-- rather than by returning quietly.

select
  'is_head_mentor carries its aal2 clause' as label,
  case when pg_get_functiondef('public.is_head_mentor()'::regprocedure) like '%aal2%'
       then 'PASS' else 'FAIL' end as verdict,
  regexp_replace(pg_get_functiondef('public.is_head_mentor()'::regprocedure), '\s+', ' ', 'g') as outcome
union all
select
  'the submission read policy is back on may_see_submission',
  case when (select qual from pg_policies
              where schemaname = 'public' and tablename = 'submission' and cmd = 'SELECT')
            = 'may_see_submission(id)'
       then 'PASS' else 'FAIL' end,
  coalesce((select qual from pg_policies
             where schemaname = 'public' and tablename = 'submission' and cmd = 'SELECT'),
           '<no select policy on submission>')
union all
select
  'helper 3 reaches by author again, with no may_see_subject widening',
  case when pg_get_functiondef('public.may_see_submission(uuid)'::regprocedure) not like '%may_see_subject%'
       then 'PASS' else 'FAIL' end,
  regexp_replace(pg_get_functiondef('public.may_see_submission(uuid)'::regprocedure), '\s+', ' ', 'g')
union all
select
  'is_portal_admin is UNCHANGED by this harness (reported, not fixed)',
  'note',
  case when pg_get_functiondef('public.is_portal_admin()'::regprocedure) like '%aal2%'
       then 'carries aal2: CDT-00 20260821120000_admin_mfa.sql has been applied since'
       else 'no aal2 clause: 20260821120000_admin_mfa.sql is still unapplied' end;

commit;
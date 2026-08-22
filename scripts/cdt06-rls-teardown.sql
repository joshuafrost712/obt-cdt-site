-- CDT-06a D8: remove this spec's fixtures, and the harness's own objects.
--
--   node scripts/cdt06-fixtures.mjs --teardown     (calls this file, then the
--                                                   Auth admin API for the users)
--
-- ## Deletion is by JOIN, never by a LIKE prefix on a uuid
--
-- cairn's teardown works because `mentoring_conversation.id` is text
-- (tl05-rls-teardown.sql:11). CDT-02's spine is uuid-keyed: `assignment`,
-- `assignment_event`, `submission`, `submission_rating` and `submission_file`
-- carry no text column holding a prefix, so `delete … where like 'cdt06-rls-%'`
-- is not expressible against them and "counted for surviving cdt06- rows" cannot
-- be executed. Everything reaches its rows through the fixture PROFILE ids, which
-- do carry the prefix in their email.
--
-- ## Both prefixes, and only both prefixes
--
-- `cdt06-rls-` and `cdt06-ui-`, neither a prefix of the other, which is the
-- lesson `tl05-rls-teardown.sql:5-9` records: one spec's two harnesses matched a
-- shared `tl05-` and deleted each other's accounts. `cdt04-ui-` is a third
-- prefix, belongs to another spec, and is not touched anywhere in this file.
--
-- ## Never a truncation
--
-- The live project may hold another session's fixtures in the same tables. Every
-- statement below is scoped; none is a `truncate`.
--
-- ## The approval-immutability trigger has to be stood down, narrowly
--
-- CDT-02 D5 puts `before update or delete` triggers on `submission` and
-- `submission_rating` refusing any change once `approved_at` is non-null, and a
-- BEFORE DELETE trigger fires for `postgres` too. The approval matrix drives
-- submissions toward approval on purpose, so the delete of an approved fixture
-- would be refused and the zero count would be unreachable. Each trigger is
-- disabled by name, immediately before the deletes, and re-enabled in this same
-- file. `session_replication_role = 'replica'` is the blunter alternative and is
-- NOT used, because it also silences the FK checks that keep the delete order
-- honest.
--
-- ## Idempotent
--
-- A second run is a clean no-op. A teardown that errors on an already-clean
-- database is a teardown nobody runs when it matters.

begin;

create temporary table cdt06_teardown_report (
  seq serial primary key, section text, verdict text, expect text, label text, outcome text
) on commit drop;

-- Every profile in either lane. One expression, used by every delete below, so a
-- table cannot be reached by a different rule than its neighbour.
create temporary view cdt06_fixture_profiles as
  select id from public.profiles
   where email like 'cdt06-rls-%' or email like 'cdt06-ui-%';

-- THREE guards stand between these fixtures and their own removal, and the spec
-- named one. Each is disabled by name here and re-enabled below.
--
--   submission_locked_after_approval        CDT-02 D5, refuses any change once
--   submission_rating_locked_after_approval approved_at is non-null. The approval
--                                           matrix drives submissions toward
--                                           approval on purpose, and a BEFORE
--                                           DELETE trigger fires for postgres too.
--
--   portal_admin_guard_last_trigger         found by this teardown failing:
--     "Refusing to delete the last OBT-CDT administrator." The fixtures create the
--     only two portal_admin rows on this project, because member_allowlist is
--     still empty and no real administrator exists yet, so removing both trips a
--     guard that is entirely correct on a populated project. It will stop firing
--     once a real administrator is enrolled. Until then a teardown that does not
--     stand it down leaves fixture administrators behind, which is the worst row
--     to leave behind.
--
-- `session_replication_role = 'replica'` would silence all three in one line and
-- is NOT used, because it also silences the FK checks keeping the delete order
-- honest.

alter table public.submission        disable trigger submission_locked_after_approval;
alter table public.submission_rating disable trigger submission_rating_locked_after_approval;
alter table public.portal_admin      disable trigger portal_admin_guard_last_trigger;

-- FK order, stated explicitly, deepest first.
delete from public.submission_rating
 where submission_id in (
   select s.id from public.submission s
    where s.consultant_profile_id in (select id from cdt06_fixture_profiles)
       or s.assignment_id in (
            select a.id from public.assignment a
             where a.consultant_profile_id in (select id from cdt06_fixture_profiles)
                or a.subject_profile_id    in (select id from cdt06_fixture_profiles)));

delete from public.submission_file
 where submission_id in (
   select s.id from public.submission s
    where s.consultant_profile_id in (select id from cdt06_fixture_profiles)
       or s.assignment_id in (
            select a.id from public.assignment a
             where a.consultant_profile_id in (select id from cdt06_fixture_profiles)
                or a.subject_profile_id    in (select id from cdt06_fixture_profiles)));

delete from public.submission
 where consultant_profile_id in (select id from cdt06_fixture_profiles)
    or assignment_id in (
         select a.id from public.assignment a
          where a.consultant_profile_id in (select id from cdt06_fixture_profiles)
             or a.subject_profile_id    in (select id from cdt06_fixture_profiles));

delete from public.assignment_event
 where assignment_id in (
   select a.id from public.assignment a
    where a.consultant_profile_id in (select id from cdt06_fixture_profiles)
       or a.subject_profile_id    in (select id from cdt06_fixture_profiles));

-- second_of is a self reference, so the secondaries go before their primaries.
delete from public.assignment
 where second_of is not null
   and (consultant_profile_id in (select id from cdt06_fixture_profiles)
     or subject_profile_id    in (select id from cdt06_fixture_profiles));

delete from public.assignment
 where consultant_profile_id in (select id from cdt06_fixture_profiles)
    or subject_profile_id    in (select id from cdt06_fixture_profiles);

delete from public.consultant_qualification where profile_id in (select id from cdt06_fixture_profiles);
delete from public.consultant             where profile_id in (select id from cdt06_fixture_profiles);
delete from public.cit_enrollment         where profile_id in (select id from cdt06_fixture_profiles);
delete from public.head_mentor            where profile_id in (select id from cdt06_fixture_profiles);
delete from public.portal_admin           where profile_id in (select id from cdt06_fixture_profiles);

alter table public.submission        enable trigger submission_locked_after_approval;
alter table public.submission_rating enable trigger submission_rating_locked_after_approval;
alter table public.portal_admin      enable trigger portal_admin_guard_last_trigger;

do $$
declare _n int;
begin
  select count(*) into _n from pg_trigger
   where not tgisinternal and tgenabled = 'D'
     and tgrelid in ('public.submission'::regclass, 'public.submission_rating'::regclass,
                     'public.portal_admin'::regclass);
  insert into cdt06_teardown_report (section, verdict, label, outcome)
  values ('teardown', case when _n = 0 then 'PASS' else 'FAIL' end,
          'all three guard triggers are disabled and re-enabled in this same file',
          'triggers left disabled: ' || _n);
end $$;

-- The harness's own five objects, dropped by name because nothing else will ever
-- remove them. They live inside cdt06-rls-tests.sql's rolled-back transaction and
-- so normally do not exist; this is the path for a psql run without that wrapper.
drop function if exists cdt06_try(text,text,text,uuid,text,text,text,text,text);
drop function if exists cdt06_assert(text,text,boolean,text);
drop function if exists cdt06_note(text,text,text);
drop table if exists cdt06_expect;
drop table if exists cdt06_caller;
drop table if exists cdt06_scope;
drop table if exists cdt06_excluded;
drop table if exists cdt06_results;
drop table if exists cdt06_scratch_undeclared;

-- ------------------------------------------------------------- the re-count
--
-- Every table the fixtures touched, counted through the SAME joins, asserted at
-- zero and printed table by table. A teardown that silently misses a table leaves
-- fixtures in a database about to hold real assessment data.
--
-- profiles, member_allowlist, the auth users and the ephemeral instrument rows are
-- counted by cdt06-fixtures.mjs --teardown, which owns them: profiles cascade from
-- auth.users, and the allowlist delete NAMES its fourteen addresses rather than
-- matching a pattern, because the rest of that table is the real cohort roster.

-- Each count is written out, in the same join the delete used, because a generic
-- count driven by column-name introspection reports zero for a table it failed to
-- reach and reads exactly like a clean teardown.
do $$
declare
  r record;
  _n bigint;
begin
  for r in
    select * from (values
      ('assignment', $q$select count(*) from public.assignment a
          where a.consultant_profile_id in (select id from cdt06_fixture_profiles)
             or a.subject_profile_id    in (select id from cdt06_fixture_profiles)$q$),
      ('assignment_event', $q$select count(*) from public.assignment_event e
          join public.assignment a on a.id = e.assignment_id
          where a.consultant_profile_id in (select id from cdt06_fixture_profiles)
             or a.subject_profile_id    in (select id from cdt06_fixture_profiles)$q$),
      ('submission', $q$select count(*) from public.submission s
          where s.consultant_profile_id in (select id from cdt06_fixture_profiles)
             or s.assignment_id in (select a.id from public.assignment a
                   where a.consultant_profile_id in (select id from cdt06_fixture_profiles)
                      or a.subject_profile_id    in (select id from cdt06_fixture_profiles))$q$),
      ('submission_rating', $q$select count(*) from public.submission_rating x
          join public.submission s on s.id = x.submission_id
          where s.consultant_profile_id in (select id from cdt06_fixture_profiles)$q$),
      ('submission_file', $q$select count(*) from public.submission_file x
          join public.submission s on s.id = x.submission_id
          where s.consultant_profile_id in (select id from cdt06_fixture_profiles)$q$),
      ('consultant', $q$select count(*) from public.consultant
          where profile_id in (select id from cdt06_fixture_profiles)$q$),
      ('consultant_qualification', $q$select count(*) from public.consultant_qualification
          where profile_id in (select id from cdt06_fixture_profiles)$q$),
      ('cit_enrollment', $q$select count(*) from public.cit_enrollment
          where profile_id in (select id from cdt06_fixture_profiles)$q$),
      ('head_mentor', $q$select count(*) from public.head_mentor
          where profile_id in (select id from cdt06_fixture_profiles)$q$),
      ('portal_admin', $q$select count(*) from public.portal_admin
          where profile_id in (select id from cdt06_fixture_profiles)$q$)
    ) as v(table_name, counter)
  loop
    execute r.counter into _n;
    insert into cdt06_teardown_report (section, verdict, label, outcome)
    values ('teardown', case when _n = 0 then 'PASS' else 'FAIL' end,
            'surviving fixture rows in ' || r.table_name, 'rows=' || _n);
  end loop;
end $$;

do $$
declare _n bigint;
begin
  select count(*) into _n from pg_class
   where relnamespace = 'public'::regnamespace and relname like 'cdt06%';
  insert into cdt06_teardown_report (section, verdict, label, outcome)
  values ('teardown', case when _n = 0 then 'PASS' else 'FAIL' end,
          'harness tables gone, confirmed from pg_class and not from a missing error',
          'cdt06% relations: ' || _n);

  select count(*) into _n from pg_proc
   where pronamespace = 'public'::regnamespace and proname like 'cdt06%';
  insert into cdt06_teardown_report (section, verdict, label, outcome)
  values ('teardown', case when _n = 0 then 'PASS' else 'FAIL' end,
          'harness functions gone, confirmed from pg_proc',
          'cdt06% functions: ' || _n);
end $$;

select seq, section, verdict, coalesce(expect,'') as expect, label, coalesce(outcome,'') as outcome
  from cdt06_teardown_report order by seq;

commit;
